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
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

type CompiledPattern = {
	raw: string;
	absolute?: string;
	relative?: string;
	basename?: string;
	glob?: RegExp;
};

const DENYLIST_FILE = path.join(os.homedir(), ".pi", "context-denylist");

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

	return {
		raw,
		absolute,
		relative,
		basename: path.basename(normalized),
		glob: hasGlob ? globToRegExp(path.isAbsolute(expanded) ? absolute : normalized) : undefined,
	};
}

function globToRegExp(glob: string): RegExp {
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

	return new RegExp(`^(?:${source})$`);
}

function candidatePaths(candidatePath: string, cwd: string): string[] {
	const absolute = normalizeAbsolute(candidatePath, cwd);
	const relative = toPosix(path.relative(cwd, absolute));
	return [absolute, relative, path.basename(absolute)];
}

function pathMatches(candidatePath: string, pattern: CompiledPattern, cwd: string): boolean {
	const candidates = candidatePaths(candidatePath, cwd);

	if (pattern.glob) return candidates.some((candidate) => pattern.glob?.test(candidate));

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

export default function contextDenylist(pi: ExtensionAPI) {
	const rawPatterns = readDenylist();
	let cwd = process.cwd();
	let patterns = compilePatterns(rawPatterns, cwd);

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		patterns = compilePatterns(rawPatterns, cwd);
		if (patterns.length > 0) {
			ctx.ui.setStatus("context-denylist", ctx.ui.theme.fg("muted", `denylist: ${patterns.length}`));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("context-denylist", undefined);
	});

	pi.on("before_agent_start", async (event) => {
		if (patterns.length === 0) return;

		const promptCwd = event.systemPromptOptions.cwd;
		if (promptCwd !== cwd) {
			cwd = promptCwd;
			patterns = compilePatterns(rawPatterns, cwd);
		}

		const contextFiles = event.systemPromptOptions.contextFiles ?? [];
		const skills = event.systemPromptOptions.skills ?? [];

		const filteredContextFiles = contextFiles.filter(
			(contextFile) => !isDenied([contextFile.path], patterns, cwd),
		);
		const filteredSkills = skills.filter(
			(skill: Skill) => !isDenied([skill.filePath, skill.baseDir], patterns, cwd),
		);

		if (filteredContextFiles.length === contextFiles.length && filteredSkills.length === skills.length) return;

		let systemPrompt = removeProjectContextSection(event.systemPrompt);
		systemPrompt = removeSkillsSection(systemPrompt);
		systemPrompt = insertBeforeCurrentDate(systemPrompt, formatContextFiles(filteredContextFiles));
		systemPrompt = insertBeforeCurrentDate(systemPrompt, formatSkillsForPrompt(filteredSkills));

		return { systemPrompt };
	});
}
