import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createAgentSession, getAgentDir, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent } from "@thinkrail/contracts";
import { sessionRunSnapshot } from "./agentSessionManager";

export type ReadOnlyTool = "read" | "grep" | "glob";

export interface ReadOnlyAgentStep {
	tool: ReadOnlyTool;
	target: string;
}

export interface ReadOnlyAgentRequest {
	/** The live chat whose folder, model and thinking level the run borrows. */
	sessionId: string;
	system: string;
	prompt: string;
	images?: ImageContent[] | undefined;
	maxLookups: number;
	signal: AbortSignal;
	onStep?: ((step: ReadOnlyAgentStep) => void) | undefined;
}

const TOOLS: readonly ReadOnlyTool[] = ["read", "grep", "glob"];

const OUTSIDE =
	"Only paths inside this repository can be looked up; keep the reference as the user wrote it.";
const SECRET = /^\.env(?:\.(?!example$|sample$|template$|dist$)[^\\/]*)?$/i;

/** `p` with its longest existing prefix resolved through symlinks. */
function real(p: string): string {
	let cur = p;
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync.native(cur), ...rest);
		} catch {
			const up = dirname(cur);
			if (up === cur) return p;
			rest.unshift(basename(cur));
			cur = up;
		}
	}
}

/**
 * Why a lookup is refused, or `null`: only read/grep/glob, only paths inside `cwd` (no URIs, `~`, `..`,
 * absolute or symlinked escapes), no `.env` secrets, and no grep through gitignored files.
 */
export function lookupBlockReason(
	tool: string,
	args: Record<string, unknown>,
	cwd: string,
): string | null {
	if (!TOOLS.some((t) => t === tool)) return `${tool} is not available here.`;
	if (tool === "grep" && args.gitignore === false) return "Ignored files are not searched.";
	const root = real(resolve(cwd));
	const raw = [args.path, args.paths].flat().filter((p): p is string => typeof p === "string");
	for (let entry of raw.flatMap((p) => p.split(";")).map((s) => s.trim().replace(/^!/, ""))) {
		if (!entry) continue;
		if (/^[a-z][a-z0-9+.-]+:/i.test(entry) || entry.startsWith("~")) return OUTSIDE;
		if (tool === "read") entry = entry.replace(/(?::(?:raw|img|conflicts|-?\d[\d,+-]*))+$/, "");
		if (entry.split(/[\\/]/).includes("..")) return OUTSIDE;
		if (SECRET.test(basename(entry))) return ".env files are not looked up.";
		const rel = relative(root, real(resolve(root, entry.replace(/[*?[{].*$/, "") || ".")));
		if (rel.split(/[\\/]/)[0] === ".." || isAbsolute(rel)) return OUTSIDE;
	}
	return null;
}

function stepTarget(tool: ReadOnlyTool, args: Record<string, unknown>): string {
	const value = tool === "grep" ? args.pattern : args.path;
	return typeof value === "string" ? value : ".";
}

/**
 * One ephemeral, read-only agent run in a live chat's folder on that chat's model and effort: only
 * read / grep / glob inside the folder, at most `maxLookups` of them, nothing persisted. Resolves with
 * the final assistant text, `null` when the chat has no usable model; rejects on abort or engine error.
 */
export async function runReadOnlyAgent(req: ReadOnlyAgentRequest): Promise<string | null> {
	const snapshot = sessionRunSnapshot(req.sessionId);
	if (!snapshot) return null;
	req.signal.throwIfAborted();
	const { cwd, generation } = snapshot;
	const { session } = await createAgentSession({
		cwd,
		agentDir: getAgentDir(),
		settings: snapshot.settings,
		authStorage: generation.runtime.authStorage,
		modelRegistry: generation.runtime.modelRegistry,
		sessionManager: SessionManager.inMemory(cwd),
		model: snapshot.model,
		...(snapshot.thinkingLevel ? { thinkingLevel: snapshot.thinkingLevel } : {}),
		systemPrompt: req.system,
		toolNames: [...TOOLS],
		restrictToolNames: true,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		noContextFiles: true,
		skills: [],
		rules: [],
		promptTemplates: [],
		slashCommands: [],
		hasUI: false,
	});
	const abort = () => void session.abort().catch(() => {});
	try {
		let lookups = 0;
		const prior = session.agent.beforeToolCall;
		session.agent.beforeToolCall = async (ctx, signal) => {
			if (++lookups > req.maxLookups)
				return {
					block: true,
					reason:
						"The lookup budget is used up. Write the rewritten prompt now from what you have.",
				};
			const tool = ctx.toolCall.name;
			const blocked = lookupBlockReason(tool, ctx.args, cwd);
			if (blocked) return { block: true, reason: blocked };
			req.onStep?.({
				tool: tool as ReadOnlyTool,
				target: stepTarget(tool as ReadOnlyTool, ctx.args),
			});
			return prior?.(ctx, signal);
		};
		req.signal.addEventListener("abort", abort, { once: true });
		await session.prompt(req.prompt, req.images?.length ? { images: req.images } : undefined);
		await session.waitForIdle();
		req.signal.throwIfAborted();
		return session.getLastAssistantText() ?? "";
	} finally {
		req.signal.removeEventListener("abort", abort);
		await session.dispose().catch(() => {});
	}
}
