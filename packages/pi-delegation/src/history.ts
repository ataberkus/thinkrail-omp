import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSessionContext,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { scanReplayTools } from "./replayTools";
import { type CapturedHistory, DelegationError, type HistoryCaptureSource } from "./types";

function invalid(message: string): never {
	throw new DelegationError("invalid-history", message);
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return typeof value === "string";
}

function nonempty(value: unknown): value is string {
	return text(value) && value.length > 0;
}

function timestamp(value: unknown): boolean {
	return text(value) && Number.isFinite(Date.parse(value));
}

function optional(value: unknown, check: (candidate: unknown) => boolean): boolean {
	return value === undefined || check(value);
}

function finite(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value);
}

function usage(value: unknown): boolean {
	if (!object(value) || !object(value.cost)) return false;
	return (
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) =>
			finite(value[key]),
		) &&
		["input", "output", "cacheRead", "cacheWrite", "total"].every(
			(key) => object(value.cost) && finite(value.cost[key]),
		) &&
		optional(value.reasoningTokens, finite) &&
		optional(value.premiumRequests, finite)
	);
}

const ASSISTANT_BLOCKS = [
	"text",
	"thinking",
	"redactedThinking",
	"toolCall",
	"image",
	"fallback",
	"anthropicServerTool",
] as const;

function content(value: unknown, kinds: readonly string[] = ["text", "image"]): boolean {
	return (
		Array.isArray(value) &&
		value.every((block: unknown) => {
			if (!object(block) || !kinds.includes(String(block.type))) return false;
			switch (block.type) {
				case "text":
					return text(block.text) && optional(block.textSignature, text);
				case "thinking":
					return text(block.thinking) && optional(block.thinkingSignature, text);
				case "redactedThinking":
					return text(block.data);
				case "fallback":
					return object(block.from) && object(block.to);
				case "anthropicServerTool":
					return object(block.block);
				case "image":
					return text(block.data) && nonempty(block.mimeType);
				case "toolCall":
					return (
						nonempty(block.id) &&
						nonempty(block.name) &&
						object(block.arguments) &&
						optional(block.thoughtSignature, text)
					);
				default:
					return false;
			}
		})
	);
}

function message(value: unknown): boolean {
	if (!object(value) || !finite(value.timestamp)) return false;
	switch (value.role) {
		case "user":
		case "developer":
			return text(value.content) || content(value.content);
		case "toolResult":
			return (
				nonempty(value.toolCallId) &&
				nonempty(value.toolName) &&
				content(value.content) &&
				typeof value.isError === "boolean"
			);
		case "bashExecution":
			return (
				text(value.command) &&
				text(value.output) &&
				optional(value.exitCode, finite) &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean"
			);
		case "pythonExecution":
			return (
				text(value.code) &&
				text(value.output) &&
				optional(value.exitCode, finite) &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean"
			);
		case "custom":
		case "hookMessage":
			return (
				nonempty(value.customType) &&
				(text(value.content) || content(value.content)) &&
				typeof value.display === "boolean"
			);
		case "fileMention":
			return Array.isArray(value.files);
		case "assistant":
			return (
				content(value.content, ASSISTANT_BLOCKS) &&
				nonempty(value.api) &&
				nonempty(value.provider) &&
				nonempty(value.model) &&
				STOP_REASONS.includes(String(value.stopReason)) &&
				usage(value.usage) &&
				["responseId", "errorMessage", "upstreamProvider", "upstreamModel"].every((key) =>
					optional(value[key], text),
				)
			);
		default:
			return false;
	}
}

const STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted"];

const THINKING_SELECTORS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"inherit",
	"auto",
];

function selector(value: unknown): boolean {
	return value === undefined || value === null || THINKING_SELECTORS.includes(String(value));
}

function flag(value: unknown): boolean {
	return typeof value === "boolean";
}

function entryShape(entry: Record<string, unknown>): boolean {
	switch (entry.type) {
		case "message":
			return message(entry.message);
		case "model_change":
			return (
				nonempty(entry.model) &&
				optional(entry.role, text) &&
				optional(entry.resolvedModelIsFallback, flag)
			);
		case "thinking_level_change":
			return selector(entry.thinkingLevel) && selector(entry.configured);
		case "service_tier_change":
			return entry.serviceTier === null || object(entry.serviceTier);
		case "model_usage":
			return (
				nonempty(entry.purpose) &&
				nonempty(entry.api) &&
				nonempty(entry.provider) &&
				nonempty(entry.model) &&
				usage(entry.usage) &&
				STOP_REASONS.includes(String(entry.stopReason)) &&
				optional(entry.role, text) &&
				optional(entry.errorMessage, text)
			);
		case "compaction":
			return (
				text(entry.summary) &&
				optional(entry.shortSummary, text) &&
				text(entry.firstKeptEntryId) &&
				finite(entry.tokensBefore) &&
				optional(entry.tokensAfter, finite) &&
				optional(entry.method, text) &&
				optional(entry.providerReplayThroughEntryId, text) &&
				optional(entry.fromExtension, flag) &&
				optional(entry.warning, text)
			);
		case "branch_summary":
			return text(entry.summary) && nonempty(entry.fromId) && optional(entry.fromExtension, flag);
		case "label":
			return nonempty(entry.targetId) && (entry.label === undefined || text(entry.label));
		case "title_change":
			return text(entry.title) && text(entry.source);
		case "custom":
			return nonempty(entry.customType);
		case "custom_message":
			return (
				nonempty(entry.customType) &&
				(text(entry.content) || content(entry.content)) &&
				flag(entry.display)
			);
		case "ttsr_injection":
			return Array.isArray(entry.injectedRules) && entry.injectedRules.every(text);
		case "session_init":
			return (
				(text(entry.systemPrompt) ||
					(Array.isArray(entry.systemPrompt) && entry.systemPrompt.every(text))) &&
				text(entry.task) &&
				Array.isArray(entry.tools) &&
				entry.tools.every(text)
			);
		case "mode_change":
			return text(entry.mode);
		case "credential_pin":
			return nonempty(entry.provider) && nonempty(entry.hash);
		case "reset_boundary":
			return true;
		default:
			return false;
	}
}

export interface Transcript {
	header: SessionHeader;
	entries: SessionEntry[];
}

export function parseTranscript(jsonl: string, sessionId: string): Transcript {
	if (!jsonl.endsWith("\n")) invalid("Transcript must be newline-ended JSONL");
	let values: unknown[];
	try {
		values = jsonl
			.slice(0, -1)
			.split("\n")
			.map((line) => JSON.parse(line));
	} catch {
		invalid("Malformed transcript JSONL");
	}
	return parseTranscriptValues(values, sessionId);
}

function sessionHeader(value: unknown, sessionId: string): value is SessionHeader {
	return (
		object(value) &&
		value.type === "session" &&
		value.version === 3 &&
		value.id === sessionId &&
		nonempty(value.id) &&
		text(value.cwd) &&
		timestamp(value.timestamp) &&
		(value.parentSession === undefined || text(value.parentSession))
	);
}

function sessionEntry(value: unknown): value is SessionEntry {
	return (
		object(value) &&
		nonempty(value.id) &&
		timestamp(value.timestamp) &&
		(value.parentId === null || nonempty(value.parentId)) &&
		entryShape(value)
	);
}

export function parseTranscriptValues(values: readonly unknown[], sessionId: string): Transcript {
	const header = values[0];
	if (!sessionHeader(header, sessionId)) invalid("Invalid pi v3 session header or identity");
	const byId = new Map<string, SessionEntry>();
	const entries: SessionEntry[] = [];
	for (const entry of values.slice(1)) {
		if (
			!sessionEntry(entry) ||
			byId.has(entry.id) ||
			(entry.parentId !== null && !byId.has(entry.parentId))
		) {
			invalid("Invalid entry, duplicate id or broken ancestry");
		}
		if (
			entry.type === "compaction" &&
			entry.firstKeptEntryId !== "" &&
			entry.firstKeptEntryId !== entry.id
		) {
			let ancestor = entry.parentId === null ? undefined : byId.get(entry.parentId);
			while (ancestor && ancestor.id !== entry.firstKeptEntryId) {
				ancestor = ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
			}
			if (!ancestor) invalid("Compaction firstKeptEntryId is not on its ancestor path");
		}
		byId.set(entry.id, entry);
		entries.push(entry);
	}
	return { header, entries };
}

export function branchAt(transcript: Transcript, entryId: string | null): SessionEntry[] {
	if (entryId === null) return [];
	const byId = new Map(transcript.entries.map((entry) => [entry.id, entry]));
	let entry = byId.get(entryId);
	if (!entry) invalid(`Missing cut ${entryId}`);
	const branch: SessionEntry[] = [];
	while (entry) {
		branch.push(entry);
		entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
	}
	return branch.reverse();
}

function digest(jsonl: string): string {
	return createHash("sha256").update(jsonl, "utf8").digest("hex");
}

function serialize(header: SessionHeader, branch: SessionEntry[]): string {
	try {
		return `${[header, ...branch].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	} catch {
		invalid("Session history cannot be serialized as JSONL");
	}
}

export function captureBranch(transcript: Transcript, entryId: string | null): CapturedHistory {
	const branch = branchAt(transcript, entryId);
	const jsonl = serialize(transcript.header, branch);
	const history: CapturedHistory = {
		format: "pi-session-branch-v1",
		sourceSessionId: transcript.header.id,
		entryId,
		sha256: digest(jsonl),
		sizeBytes: Buffer.byteLength(jsonl, "utf8"),
		jsonl,
	};
	validateHistory(history);
	return Object.freeze(history);
}

export function validateHistory(history: CapturedHistory): Transcript {
	if (
		history.format !== "pi-session-branch-v1" ||
		typeof history.jsonl !== "string" ||
		history.sizeBytes !== Buffer.byteLength(history.jsonl, "utf8") ||
		history.sha256 !== digest(history.jsonl) ||
		!(history.entryId === null || nonempty(history.entryId))
	)
		invalid("Invalid capture format, boundary, digest or length");
	const transcript = parseTranscript(history.jsonl, history.sourceSessionId);
	const branch = branchAt(transcript, history.entryId);
	if (
		branch.length !== transcript.entries.length ||
		branch.some((entry, index) => entry.id !== transcript.entries[index]?.id)
	) {
		invalid("Capture does not end exactly at its declared cut");
	}
	const { messages } = buildSessionContext(branch, history.entryId);
	const { issues } = scanReplayTools(messages);
	if (issues.length) throw new DelegationError("incomplete-history", issues.join("; "));
	return transcript;
}

export function captureSession(
	source: Extract<HistoryCaptureSource, { kind: "session" }>,
): CapturedHistory {
	const manager = source.sessionManager;
	if (manager.getSessionId() !== source.sessionId) invalid("Session manager identity mismatch");
	const header = manager.getHeader();
	if (!header) throw new DelegationError("history-unavailable", "Source has no session header");
	let entryId: string | null;
	let branch: SessionEntry[];
	if (source.cut.kind === "at-entry") {
		entryId = source.cut.entryId;
		branch = entryId === null ? [] : manager.getBranch(entryId);
	} else {
		branch = parseTranscript(serialize(header, manager.getBranch()), source.sessionId).entries;
		const toolCallId = source.cut.toolCallId;
		const matches = branch.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content
						.filter((block) => block.type === "toolCall" && block.id === toolCallId)
						.map(() => entry)
				: [],
		);
		if (matches.length !== 1 || !matches[0]) invalid("Missing or ambiguous calling tool batch");
		entryId = matches[0].parentId;
		branch = entryId === null ? [] : manager.getBranch(entryId);
	}
	const jsonl = serialize(header, branch);
	return captureBranch(parseTranscript(jsonl, source.sessionId), entryId);
}

export async function forkCaptured(
	history: CapturedHistory,
	cwd: string,
	sessionDir: string,
): Promise<SessionManager> {
	validateHistory(history);
	const dir = mkdtempSync(join(tmpdir(), "pi-delegation-seed-"));
	try {
		const file = join(dir, "seed.jsonl");
		writeFileSync(file, history.jsonl, { mode: 0o600, flag: "wx" });
		return await SessionManager.forkFrom(file, cwd, sessionDir, undefined, {
			copyArtifacts: false,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
