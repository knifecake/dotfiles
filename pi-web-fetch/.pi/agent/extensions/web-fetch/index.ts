import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, TruncationResult } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const EXA_MCP_BASE_URL = "https://mcp.exa.ai/mcp";

const DEFAULT_RESULTS = 8;
const EXA_MAX_RESULTS = 25;
const BRAVE_MAX_RESULTS = 20;

const DEFAULT_FETCH_MAX_CHARS = 20_000;
const MIN_FETCH_MAX_CHARS = 1_000;
const MAX_FETCH_MAX_CHARS = 200_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

const PROVIDERS = ["auto", "brave", "exa"] as const;
type Provider = (typeof PROVIDERS)[number];

const EXA_TYPES = ["auto", "fast", "deep"] as const;

const WebSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(
		Type.Number({
			description: `Number of results to return (default: ${DEFAULT_RESULTS})`,
			minimum: 1,
			maximum: EXA_MAX_RESULTS,
		}),
	),
	provider: Type.Optional(
		StringEnum(PROVIDERS, {
			description: "Provider preference: auto (default), brave, or exa",
		}),
	),
	country: Type.Optional(
		Type.String({
			description: "Two-letter country code for Brave results (default: US)",
			minLength: 2,
			maxLength: 2,
		}),
	),
	freshness: Type.Optional(
		Type.String({
			description:
				"Freshness filter for Brave: pd (day), pw (week), pm (month), py (year), or YYYY-MM-DDtoYYYY-MM-DD",
		}),
	),
	exaSearchType: Type.Optional(
		StringEnum(EXA_TYPES, {
			description: "Exa search type: auto (balanced), fast, or deep",
		}),
	),
});

const WebFetchSchema = Type.Object({
	url: Type.String({
		description: "URL to fetch (must use http or https)",
	}),
	maxChars: Type.Optional(
		Type.Number({
			description: `Maximum extracted characters before output truncation (default: ${DEFAULT_FETCH_MAX_CHARS})`,
			minimum: MIN_FETCH_MAX_CHARS,
			maximum: MAX_FETCH_MAX_CHARS,
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Request timeout in milliseconds (default: ${DEFAULT_FETCH_TIMEOUT_MS})`,
			minimum: 1_000,
			maximum: 60_000,
		}),
	),
});

type WebSearchParams = Static<typeof WebSearchSchema>;
type WebFetchParams = Static<typeof WebFetchSchema>;

interface BraveResult {
	title: string;
	url: string;
	snippet: string;
	age?: string;
}

interface SearchRunResult {
	provider: Exclude<Provider, "auto">;
	output: string;
	resultCount?: number;
	fallbackFrom?: "brave";
}

interface WebSearchDetails {
	query: string;
	provider: Exclude<Provider, "auto">;
	resultCount?: number;
	fallbackFrom?: "brave";
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

interface WebFetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	extractedChars: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

function normalizeProvider(value: string | undefined): Provider | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	return PROVIDERS.find((provider) => provider === normalized);
}

function getExaMcpUrl() {
	const apiKey = process.env.EXA_API_KEY?.trim();
	if (!apiKey) return EXA_MCP_BASE_URL;

	const url = new URL(EXA_MCP_BASE_URL);
	url.searchParams.set("exaApiKey", apiKey);
	return url.toString();
}

function clampResultCount(value: number | undefined): number {
	if (!value || Number.isNaN(value)) return DEFAULT_RESULTS;
	return Math.max(1, Math.min(EXA_MAX_RESULTS, Math.floor(value)));
}

function clampFetchChars(value: number | undefined): number {
	if (!value || Number.isNaN(value)) return DEFAULT_FETCH_MAX_CHARS;
	return Math.max(MIN_FETCH_MAX_CHARS, Math.min(MAX_FETCH_MAX_CHARS, Math.floor(value)));
}

function clampTimeoutMs(value: number | undefined): number {
	if (!value || Number.isNaN(value)) return DEFAULT_FETCH_TIMEOUT_MS;
	return Math.max(1_000, Math.min(60_000, Math.floor(value)));
}

function createTimeoutSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();

	const onAbort = () => controller.abort();
	if (parentSignal?.aborted) controller.abort();
	parentSignal?.addEventListener("abort", onAbort, { once: true });

	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const cleanup = () => {
		clearTimeout(timeoutId);
		parentSignal?.removeEventListener("abort", onAbort);
	};

	return { signal: controller.signal, cleanup };
}

async function searchWithBrave(params: WebSearchParams, signal?: AbortSignal): Promise<SearchRunResult> {
	const apiKey = process.env.BRAVE_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"BRAVE_API_KEY is not set. Add it to your environment or use provider='exa'.",
		);
	}

	const resultCount = Math.min(clampResultCount(params.numResults), BRAVE_MAX_RESULTS);
	const country = (params.country ?? "US").toUpperCase();

	const searchParams = new URLSearchParams({
		q: params.query,
		count: resultCount.toString(),
		country,
		text_decorations: "false",
		extra_snippets: "true",
	});

	if (params.freshness) {
		searchParams.set("freshness", params.freshness);
	}

	const { signal: timeoutSignal, cleanup } = createTimeoutSignal(signal, 25_000);
	try {
		const response = await fetch(`${BRAVE_API_URL}?${searchParams.toString()}`, {
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
			},
			signal: timeoutSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Brave Search error (${response.status}): ${errorText || response.statusText}`);
		}

		const data = (await response.json()) as {
			web?: {
				results?: Array<{
					title?: string;
					url?: string;
					description?: string;
					extra_snippets?: string[];
					age?: string;
					page_age?: string;
				}>;
			};
		};

		const results: BraveResult[] = (data.web?.results ?? [])
			.slice(0, resultCount)
			.map((result) => {
				const extraSnippetText = (result.extra_snippets ?? []).filter(Boolean).join(" ");
				const snippet = [result.description ?? "", extraSnippetText].filter(Boolean).join(" ").trim();

				return {
					title: result.title?.trim() || "(no title)",
					url: result.url?.trim() || "",
					snippet,
					age: result.age ?? result.page_age,
				};
			})
			.filter((result) => result.url.length > 0);

		if (results.length === 0) {
			return {
				provider: "brave",
				resultCount: 0,
				output: `No Brave Search results found for: ${params.query}`,
			};
		}

		const lines: string[] = [];
		lines.push(`Brave Search results for: \"${params.query}\"`);
		lines.push("");

		for (const [index, result] of results.entries()) {
			lines.push(`${index + 1}. ${result.title}`);
			lines.push(`   URL: ${result.url}`);
			if (result.age?.trim()) {
				lines.push(`   Age: ${result.age.trim()}`);
			}
			if (result.snippet) {
				lines.push(`   Snippet: ${result.snippet}`);
			}
			lines.push("");
		}

		return {
			provider: "brave",
			resultCount: results.length,
			output: lines.join("\n").trim(),
		};
	} finally {
		cleanup();
	}
}

function parseExaSSE(responseText: string): string | undefined {
	const lines = responseText.split("\n");
	let lastText: string | undefined;

	for (const line of lines) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice("data:".length).trim();
		if (!payload || payload === "[DONE]") continue;

		try {
			const parsed = JSON.parse(payload) as {
				result?: {
					content?: Array<{ type?: string; text?: string }>;
				};
			};

			const text = parsed.result?.content?.find((content) => content.type === "text")?.text;
			if (text && text.trim()) {
				lastText = text.trim();
			}
		} catch {
			// Ignore non-JSON SSE chunks.
		}
	}

	return lastText;
}

async function searchWithExa(params: WebSearchParams, signal?: AbortSignal): Promise<SearchRunResult> {
	const resultCount = clampResultCount(params.numResults);
	const { signal: timeoutSignal, cleanup } = createTimeoutSignal(signal, 25_000);

	try {
		const response = await fetch(getExaMcpUrl(), {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "web_search_exa",
					arguments: {
						query: params.query,
						numResults: resultCount,
						type: params.exaSearchType ?? "auto",
						livecrawl: "fallback",
					},
				},
			}),
			signal: timeoutSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Exa search error (${response.status}): ${errorText || response.statusText}`);
		}

		const responseText = await response.text();
		const output = parseExaSSE(responseText);
		if (!output) {
			throw new Error("Exa returned no search content.");
		}

		return {
			provider: "exa",
			resultCount,
			output: `Exa search results for: \"${params.query}\"\n\n${output}`,
		};
	} finally {
		cleanup();
	}
}

function buildProviderOrder(requestedProvider: Provider): Array<Exclude<Provider, "auto">> {
	if (requestedProvider === "brave") return ["brave"];
	if (requestedProvider === "exa") return ["exa"];

	return process.env.BRAVE_API_KEY ? ["brave", "exa"] : ["exa"];
}

async function runSearch(params: WebSearchParams, signal?: AbortSignal): Promise<SearchRunResult> {
	const defaultProvider = normalizeProvider(process.env.PI_WEB_SEARCH_PROVIDER) ?? "auto";
	const requestedProvider = params.provider ?? defaultProvider;

	const order = buildProviderOrder(requestedProvider);
	const errors: string[] = [];

	for (const provider of order) {
		try {
			if (provider === "brave") {
				return await searchWithBrave(params, signal);
			}

			const exa = await searchWithExa(params, signal);
			if (requestedProvider === "auto" && order[0] === "brave") {
				exa.fallbackFrom = "brave";
			}
			return exa;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${provider}: ${message}`);
		}
	}

	throw new Error(`Web search failed. Tried ${order.join(", ")}. ${errors.join(" | ")}`);
}

function decodeHtmlEntities(input: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};

	return input
		.replace(/&#(\d+);/g, (_, code) => {
			const value = Number.parseInt(code, 10);
			if (Number.isNaN(value)) return _;
			try {
				return String.fromCodePoint(value);
			} catch {
				return _;
			}
		})
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
			const value = Number.parseInt(code, 16);
			if (Number.isNaN(value)) return _;
			try {
				return String.fromCodePoint(value);
			} catch {
				return _;
			}
		})
		.replace(/&([a-zA-Z]+);/g, (match, name) => named[name] ?? match);
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match?.[1]) return undefined;

	const title = decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim());
	return title || undefined;
}

function htmlToText(html: string): string {
	let text = html;

	text = text
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
		.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
		.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
		.replace(/<canvas\b[^<]*(?:(?!<\/canvas>)<[^<]*)*<\/canvas>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|main|header|footer|aside|li|ul|ol|h[1-6]|tr|table)>/gi, "\n")
		.replace(/<[^>]+>/g, " ");

	text = decodeHtmlEntities(text)
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return text;
}

async function fetchWebPage(params: WebFetchParams, signal?: AbortSignal) {
	let targetUrl: URL;
	try {
		targetUrl = new URL(params.url);
	} catch {
		throw new Error(`Invalid URL: ${params.url}`);
	}

	if (!["http:", "https:"].includes(targetUrl.protocol)) {
		throw new Error(`Unsupported URL protocol: ${targetUrl.protocol}. Use http or https.`);
	}

	const timeoutMs = clampTimeoutMs(params.timeoutMs);
	const maxChars = clampFetchChars(params.maxChars);

	const { signal: timeoutSignal, cleanup } = createTimeoutSignal(signal, timeoutMs);
	try {
		const response = await fetch(targetUrl.toString(), {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; pi-web-search-extension/1.0; +https://github.com/badlogic/pi-mono)",
				Accept: "text/html,application/xhtml+xml,application/xml,text/plain,text/markdown,*/*;q=0.8",
			},
			signal: timeoutSignal,
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`Fetch failed (${response.status}): ${errorBody || response.statusText}`);
		}

		const contentType = (response.headers.get("content-type") ?? "unknown").toLowerCase();
		if (
			!contentType.includes("html") &&
			!contentType.includes("xhtml") &&
			!contentType.includes("json") &&
			!contentType.includes("text") &&
			!contentType.includes("xml") &&
			!contentType.includes("markdown")
		) {
			throw new Error(`Unsupported content type for web_fetch: ${contentType}`);
		}

		const rawBody = await response.text();

		let title: string | undefined;
		let extracted = rawBody;

		if (contentType.includes("html") || contentType.includes("xhtml")) {
			title = extractTitle(rawBody);
			extracted = htmlToText(rawBody);
		} else if (contentType.includes("json")) {
			try {
				extracted = JSON.stringify(JSON.parse(rawBody), null, 2);
			} catch {
				extracted = rawBody;
			}
		}

		if (!extracted.trim()) {
			throw new Error("Fetched page had no readable text content.");
		}

		let didApplyMaxChars = false;
		if (extracted.length > maxChars) {
			extracted = extracted.slice(0, maxChars);
			didApplyMaxChars = true;
		}

		const lines: string[] = [];
		lines.push(`Fetched URL: ${params.url}`);
		lines.push(`Final URL: ${response.url}`);
		lines.push(`Status: ${response.status}`);
		lines.push(`Content-Type: ${contentType}`);
		if (title) lines.push(`Title: ${title}`);
		lines.push("");
		lines.push(extracted);

		if (didApplyMaxChars) {
			lines.push("");
			lines.push(
				`[Content limited to ${maxChars} characters before tool output truncation. Increase maxChars for more text.]`,
			);
		}

		return {
			output: lines.join("\n").trim(),
			details: {
				url: params.url,
				finalUrl: response.url,
				status: response.status,
				contentType,
				extractedChars: extracted.length,
			} as Omit<WebFetchDetails, "truncation" | "fullOutputPath">,
		};
	} finally {
		cleanup();
	}
}

async function maybeTruncateOutput(output: string) {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return {
			content: truncation.content,
			truncation,
			fullOutputPath: undefined,
		};
	}

	const tempDir = await mkdtemp(join(tmpdir(), "pi-web-search-"));
	const tempFile = join(tempDir, "full-output.txt");
	await withFileMutationQueue(tempFile, async () => {
		await writeFile(tempFile, output, "utf8");
	});

	const content = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${tempFile}]`;
	return {
		content,
		truncation,
		fullOutputPath: tempFile,
	};
}

export default function webFetchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch and extract readable text from a URL (http/https). HTML pages are converted to plain text. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
		promptSnippet: "Fetch and extract readable content from a specific URL",
		promptGuidelines: [
			"Use this tool after finding promising URLs to get page content quickly.",
			"Prefer web_fetch over bash/curl for one-off page extraction tasks.",
		],
		parameters: WebFetchSchema,
		async execute(_toolCallId, rawParams, signal) {
			const params = rawParams as WebFetchParams;
			const fetched = await fetchWebPage(params, signal);
			const truncated = await maybeTruncateOutput(fetched.output);

			const details: WebFetchDetails = {
				...fetched.details,
				truncation: truncated.truncation,
				fullOutputPath: truncated.fullOutputPath,
			};

			return {
				content: [{ type: "text", text: truncated.content }],
				details,
			};
		},
	});
}
