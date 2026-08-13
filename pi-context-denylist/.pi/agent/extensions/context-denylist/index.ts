/**
 * Pi context denylist.
 *
 * Filters noisy context files and skills out of the system prompt while keeping
 * them readable on demand via the normal read tool or explicit /skill commands.
 *
 * Configure with ~/.pi/context-denylist: one path/glob per line. Use # for
 * comments. Reload Pi (or run /reload) after changing the file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

type CompiledPattern = {
	raw: string;
	absolute?: string;
	relative?: string;
	basename?: string;
	glob?: RegExp;
	globDescendant?: RegExp;
};

const DENYLIST_FILE = path.join(os.homedir(), ".pi", "context-denylist");
const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const RESOURCE_WALK_LIMIT = 25_000;

function expandUserPath(input: string): string {
	let value = input.trim();
	if (value.startsWith("@")) value = value.slice(1);
	value = value.replace(/\$\{HOME\}|\$HOME/g, os.homedir());
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function toPosix(input: string): string {
	return input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function normalizeAbsolute(input: string, cwd: string): string {
	const expanded = expandUserPath(input);
	const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	return toPosix(path.normalize(absolute));
}

function stripComment(line: string): string {
	let escaped = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (char === "#" && !escaped) return line.slice(0, i);
		escaped = char === "\\" && !escaped;
		if (char !== "\\") escaped = false;
	}
	return line;
}

function readDenylist(): string[] {
	if (!fs.existsSync(DENYLIST_FILE)) return [];

	return fs
		.readFileSync(DENYLIST_FILE, "utf8")
		.split(/\r?\n/)
		.map(stripComment)
		.map((line) => line.trim())
		.filter(Boolean);
}

function compilePatterns(rawPatterns: string[], cwd: string): CompiledPattern[] {
	return rawPatterns.map((raw) => compilePattern(raw, cwd)).filter((pattern): pattern is CompiledPattern => Boolean(pattern));
}

function compilePattern(raw: string, cwd: string): CompiledPattern | null {
	const expanded = expandUserPath(raw);
	if (!expanded) return null;

	const normalized = toPosix(path.normalize(expanded)).replace(/^\.\//, "");
	const absolute = normalizeAbsolute(expanded, cwd);
	const relative = path.isAbsolute(expanded) ? undefined : normalized;
	const hasGlob = /[*?\[\]]/.test(expanded);

	const globPattern = path.isAbsolute(expanded) ? absolute : normalized;

	return {
		raw,
		absolute,
		relative,
		basename: path.basename(normalized),
		glob: hasGlob ? globToRegExp(globPattern) : undefined,
		globDescendant: hasGlob ? globToRegExp(globPattern, { matchDescendants: true }) : undefined,
	};
}

function globToRegExp(glob: string, options: { matchDescendants?: boolean } = {}): RegExp {
	let source = "";
	const value = toPosix(glob);

	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		const next = value[i + 1];

		if (char === "*" && next === "*") {
			source += ".*";
			i += 1;
			continue;
		}
		if (char === "*") {
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		if (".+^${}()|[]\\".includes(char)) {
			source += `\\${char}`;
			continue;
		}
		source += char;
	}

	const suffix = options.matchDescendants ? "(?:/.*)?" : "";
	return new RegExp(`^(?:${source})${suffix}$`);
}

function candidatePaths(candidatePath: string, cwd: string): string[] {
	const absolute = normalizeAbsolute(candidatePath, cwd);
	const relative = toPosix(path.relative(cwd, absolute));
	return [absolute, relative, path.basename(absolute)];
}

function pathMatches(candidatePath: string, pattern: CompiledPattern, cwd: string): boolean {
	const candidates = candidatePaths(candidatePath, cwd);

	if (pattern.glob) {
		return candidates.some(
			(candidate) => pattern.glob?.test(candidate) || pattern.globDescendant?.test(candidate),
		);
	}

	for (const patternPath of [pattern.absolute, pattern.relative].filter(Boolean) as string[]) {
		const normalized = toPosix(path.normalize(patternPath));
		for (const candidate of candidates) {
			if (candidate === normalized || candidate.startsWith(`${normalized}/`)) return true;
			if (candidate.endsWith(`/${normalized}`) || candidate.includes(`/${normalized}/`)) return true;
		}
	}

	return Boolean(pattern.raw === pattern.basename && candidates.includes(pattern.basename));
}

function isDenied(paths: string[], patterns: CompiledPattern[], cwd: string): boolean {
	return paths.some((candidatePath) => patterns.some((pattern) => pathMatches(candidatePath, pattern, cwd)));
}

function ancestorDirs(start: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(start);
	const root = path.resolve("/");

	while (true) {
		dirs.push(current);
		if (current === root) break;
		const parent = path.resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	return dirs;
}

function isSameOrWithin(child: string, parent: string): boolean {
	const relativePath = path.relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isRelatedToCwd(candidatePath: string, cwd: string): boolean {
	const comparisonPath = fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()
		? path.dirname(candidatePath)
		: candidatePath;
	return isSameOrWithin(comparisonPath, cwd) || isSameOrWithin(cwd, comparisonPath);
}

function patternSearchRoots(pattern: CompiledPattern, cwd: string): string[] {
	const patternPath = pattern.absolute;
	if (!patternPath) return [];
	if (!pattern.glob) return isRelatedToCwd(patternPath, cwd) ? [patternPath] : [];

	const roots = new Set<string>();
	for (const dir of ancestorDirs(cwd)) {
		for (const filename of CONTEXT_FILE_NAMES) {
			const candidate = path.join(dir, filename);
			if (pathMatches(candidate, pattern, cwd)) roots.add(candidate);
		}

		for (const candidate of [
			path.join(dir, ".agents"),
			path.join(dir, ".agents", "skills"),
			path.join(dir, ".pi", "skills"),
		]) {
			if (pathMatches(candidate, pattern, cwd)) roots.add(candidate);
		}
	}

	return Array.from(roots);
}

function addDeniedResourceFile(
	filePath: string,
	patterns: CompiledPattern[],
	cwd: string,
	files: Set<string>,
	options: { includeContextFiles: boolean },
): void {
	const name = path.basename(filePath);
	if (name !== "SKILL.md" && (!options.includeContextFiles || !CONTEXT_FILE_NAMES.has(name))) return;
	if (isDenied([filePath, path.dirname(filePath)], patterns, cwd)) {
		files.add(normalizeAbsolute(filePath, cwd));
	}
}

function walkDeniedResourceFiles(root: string, patterns: CompiledPattern[], cwd: string, files: Set<string>): void {
	const stack = [root];
	let visited = 0;

	while (stack.length > 0 && visited < RESOURCE_WALK_LIMIT) {
		const current = stack.pop();
		if (!current) continue;
		visited += 1;

		let stats: fs.Stats;
		try {
			stats = fs.statSync(current);
		} catch {
			continue;
		}

		if (stats.isFile()) {
			addDeniedResourceFile(current, patterns, cwd, files, { includeContextFiles: true });
			continue;
		}
		if (!stats.isDirectory()) continue;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if ([".git", "node_modules", "tmp", "vendor"].includes(entry.name)) continue;
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				stack.push(fullPath);
				continue;
			}
			if (entry.isFile()) {
				addDeniedResourceFile(fullPath, patterns, cwd, files, { includeContextFiles: false });
			}
		}
	}
}

function pruneNestedRoots(roots: string[]): string[] {
	const sorted = roots.map((root) => path.resolve(root)).sort((a, b) => a.length - b.length);
	const pruned: string[] = [];

	for (const root of sorted) {
		if (pruned.some((kept) => isSameOrWithin(root, kept))) continue;
		pruned.push(root);
	}

	return pruned;
}

function countDeniedResourceFiles(patterns: CompiledPattern[], cwd: string): number {
	const files = new Set<string>();
	const roots = new Set<string>();

	for (const pattern of patterns) {
		for (const root of patternSearchRoots(pattern, cwd)) {
			roots.add(root);
		}
	}

	for (const root of pruneNestedRoots(Array.from(roots))) {
		walkDeniedResourceFiles(root, patterns, cwd, files);
	}

	return files.size;
}

function removeProjectContextSection(prompt: string): string {
	return prompt.replace(
		/\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n[\s\S]*?(?=\n\nThe following skills provide specialized instructions for specific tasks\.|\nCurrent date:)/,
		"",
	);
}

function removeSkillsSection(prompt: string): string {
	return prompt.replace(
		/\n\nThe following skills provide specialized instructions for specific tasks\.\n[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>/,
		"",
	);
}

function formatContextFiles(contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) return "";

	let block = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of contextFiles) {
		block += `## ${filePath}\n\n${content}\n\n`;
	}
	return block.replace(/\n+$/, "\n");
}

function insertBeforeCurrentDate(prompt: string, content: string): string {
	if (!content) return prompt;
	const marker = "\nCurrent date:";
	const index = prompt.lastIndexOf(marker);
	return index === -1 ? `${prompt}${content}` : `${prompt.slice(0, index)}${content}${prompt.slice(index)}`;
}

function plural(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function updateStatus(ctx: ExtensionContext, deniedFileCount: number, ruleCount: number): void {
	if (ruleCount === 0) {
		ctx.ui.setStatus("context-denylist", undefined);
		return;
	}

	ctx.ui.setStatus(
		"context-denylist",
		ctx.ui.theme.fg("muted", `${plural(deniedFileCount, "file")} / ${plural(ruleCount, "rule")}`),
	);
}

export default function contextDenylist(pi: ExtensionAPI) {
	const rawPatterns = readDenylist();
	let cwd = process.cwd();
	let patterns = compilePatterns(rawPatterns, cwd);
	let deniedResourceFileCount = 0;

	function refreshStatus(ctx: ExtensionContext): void {
		deniedResourceFileCount = countDeniedResourceFiles(patterns, cwd);
		updateStatus(ctx, deniedResourceFileCount, patterns.length);
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		patterns = compilePatterns(rawPatterns, cwd);
		refreshStatus(ctx);
	});

	pi.on("resources_discover", async (event, ctx) => {
		cwd = event.cwd;
		patterns = compilePatterns(rawPatterns, cwd);
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("context-denylist", undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (patterns.length === 0) return;

		const promptCwd = event.systemPromptOptions.cwd;
		if (promptCwd !== cwd) {
			cwd = promptCwd;
			patterns = compilePatterns(rawPatterns, cwd);
			refreshStatus(ctx);
		}

		const contextFiles = event.systemPromptOptions.contextFiles ?? [];
		const skills = event.systemPromptOptions.skills ?? [];
		const deniedFiles = new Set<string>();

		const filteredContextFiles = contextFiles.filter((contextFile) => {
			const denied = isDenied([contextFile.path], patterns, cwd);
			if (denied) deniedFiles.add(contextFile.path);
			return !denied;
		});
		const filteredSkills = skills.filter((skill: Skill) => {
			const denied = isDenied([skill.filePath, skill.baseDir], patterns, cwd);
			if (denied) deniedFiles.add(skill.filePath);
			return !denied;
		});

		updateStatus(ctx, Math.max(deniedFiles.size, deniedResourceFileCount), patterns.length);

		if (filteredContextFiles.length === contextFiles.length && filteredSkills.length === skills.length) return;

		let systemPrompt = removeProjectContextSection(event.systemPrompt);
		systemPrompt = removeSkillsSection(systemPrompt);
		systemPrompt = insertBeforeCurrentDate(systemPrompt, formatContextFiles(filteredContextFiles));
		systemPrompt = insertBeforeCurrentDate(systemPrompt, formatSkillsForPrompt(filteredSkills));

		return { systemPrompt };
	});
}
