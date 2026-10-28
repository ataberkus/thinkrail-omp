import {
	closeSync,
	type FSWatcher,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	watch,
} from "node:fs";
import { basename, isAbsolute } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
	MCP_PROTOCOL_VERSION,
	type McpListResult,
	type McpReadOutputResult,
	type McpServerResourceSummary,
	type McpServerStatus,
	type McpStatusSnapshot,
	type McpTransportKind,
	type Project,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { logger } from "../log";
import {
	getSessionMessages,
	liveSessionIdsOf,
	type McpSessionView,
	mcpSessionView,
	requestSessionReload,
	type SessionReloadDisposition,
} from "./agentSessionManager";
import { publishSessionResourcesChanged } from "./chatResources";
import {
	deriveMcpServerStatuses,
	type HostMcpServerConfig,
	isMcpResultTool,
	loadHostMcpConfig,
	mcpPolicyOf,
	type ParsedMcpStatus,
	redactMcpText,
	reportMcpRuntime,
	summarizeMcpConfigErrors,
	summarizeMcpServers,
} from "./mcp";
import { notifyExtUi } from "./webUiContext";

const log = logger("mcp");
const USER_CONFIG_DEBOUNCE_MS = 300;
const READ_OUTPUT_MAX_BYTES = 1024 * 1024;

const ATTENTION_STATES = new Set<McpServerStatus["state"]>(["failed", "needs-sign-in"]);
const ARTIFACT_URL = "artifact://";

interface Tracked {
	generation: number;
	servers: McpServerStatus[];
	transports: Map<string, McpTransportKind>;
	resourcesKey: string;
	reloadFailed: boolean;
}

const tracked = new Map<string, Tracked>();

let publish: (snapshot: McpStatusSnapshot) => void = () => {};
export function setMcpStatusPublisher(fn: (snapshot: McpStatusSnapshot) => void): void {
	publish = fn;
}

function snapshotOf(sessionId: string): McpStatusSnapshot | null {
	const view = mcpSessionView(sessionId);
	const state = tracked.get(sessionId);
	if (!view || !state || state.generation === 0) return null;
	return {
		workspaceId: view.workspaceId,
		sessionId,
		generation: state.generation,
		servers: state.servers,
	};
}

function asParsed(servers: readonly McpServerStatus[]): ParsedMcpStatus["servers"] {
	return new Map(
		servers.map((status) => [
			status.name,
			{
				state: status.state,
				...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
				detail: status.detail ?? "",
			},
		]),
	);
}

const configKey = (config: HostMcpServerConfig | undefined): string | undefined =>
	config === undefined ? undefined : JSON.stringify(config);

function configuredServers(view: McpSessionView) {
	return loadHostMcpConfig({
		agentDir: getAgentDir(),
		cwd: view.cwd,
		projectTrusted: view.projectTrusted,
		policy: view.policy,
		disabledInChat: view.disabledInChat,
	}).servers;
}

export function pendingMcpReload(sessionId: string): Set<string> {
	const view = mcpSessionView(sessionId);
	const failed = tracked.get(sessionId)?.reloadFailed === true;
	if (!view || (!view.loaded && !failed)) return new Set();
	const loaded = view.loaded ?? new Map<string, HostMcpServerConfig>();
	const current = new Map(configuredServers(view).map((server) => [server.name, server.config]));
	const names = new Set([...current.keys(), ...loaded.keys()]);
	return new Set(
		[...names].filter(
			(name) => failed || configKey(current.get(name)) !== configKey(loaded.get(name)),
		),
	);
}

function publishResources(sessionId: string, workspaceId: string, state: Tracked): void {
	const resourcesKey = JSON.stringify(mcpResourceSummaries(sessionId));
	if (resourcesKey === state.resourcesKey) return;
	state.resourcesKey = resourcesKey;
	publishSessionResourcesChanged(workspaceId, sessionId);
}

function apply(sessionId: string, reported: ParsedMcpStatus | null, partial: boolean): void {
	const view = mcpSessionView(sessionId);
	const state = tracked.get(sessionId);
	if (!view || !state) return;
	const merged: ParsedMcpStatus | null =
		partial && reported
			? {
					servers: new Map([...asParsed(state.servers), ...reported.servers]),
					configErrors: reported.configErrors,
				}
			: reported;
	const summaries = summarizeMcpServers({
		agentDir: getAgentDir(),
		cwd: view.cwd,
		projectTrusted: view.projectTrusted,
		policy: view.policy,
	});
	state.transports = new Map(
		summaries.map((summary): [string, McpTransportKind] => [summary.name, summary.transport]),
	);
	const before = new Map(state.servers.map((status) => [status.name, status.state]));
	state.servers = deriveMcpServerStatuses({
		summaries,
		reported: merged,
		disabledInChat: view.disabledInChat,
		pendingReload: pendingMcpReload(sessionId),
		previous: state.servers,
		now: Date.now(),
	});
	state.generation++;
	const snapshot = snapshotOf(sessionId);
	if (snapshot) publish(snapshot);
	publishResources(sessionId, view.workspaceId, state);
	notifyLegacyClients(
		sessionId,
		state.servers.filter(
			(status) => ATTENTION_STATES.has(status.state) && before.get(status.name) !== status.state,
		),
	);
}

function notifyLegacyClients(sessionId: string, attention: readonly McpServerStatus[]): void {
	if (attention.length === 0) return;
	const lines = attention.map(
		(status) => `  ${status.name} (${status.state})${status.detail ? `: ${status.detail}` : ""}`,
	);
	notifyExtUi(
		sessionId,
		["MCP servers need attention:", ...lines, "Open Settings › MCP servers to fix."].join("\n"),
		"warning",
		{ belowProtocol: MCP_PROTOCOL_VERSION },
	);
}

export function showPendingMcpReload(sessionId: string): void {
	apply(sessionId, null, true);
}

export function restartMcpStatus(sessionId: string): void {
	const view = mcpSessionView(sessionId);
	if (!view) return;
	trackedOf(sessionId).reloadFailed = false;
	apply(sessionId, reportMcpRuntime(view.runtime), false);
}

export function assertMcpServerDisablableInChat(sessionId: string, name: string): void {
	const view = mcpSessionView(sessionId);
	if (!view) throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
	if (view.loaded?.has(name)) return;
	if (
		view.loaded === null &&
		hasFailedMcpReload(sessionId) &&
		configuredServers(view).some((server) => server.name === name)
	)
		return;
	throw new CodedError(
		"MCP_CONFIG_INVALID",
		`No MCP server named "${name}" is configured for this chat.`,
	);
}

export function mcpResourceSummaries(sessionId: string): McpServerResourceSummary[] {
	const state = tracked.get(sessionId);
	if (!state) return [];
	return state.servers.map((status) => ({
		name: status.name,
		state: status.state,
		...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
		transport: state.transports.get(status.name) ?? "stdio",
	}));
}

export function hasFailedMcpReload(sessionId: string): boolean {
	return tracked.get(sessionId)?.reloadFailed === true;
}

export function recordMcpReloadFailure(
	sessionId: string,
	error: unknown,
	wasLoaded: boolean,
): void {
	const state = tracked.get(sessionId);
	const view = mcpSessionView(sessionId);
	if (!state || !view || (!wasLoaded && view.loaded === null && !state.reloadFailed)) return;
	state.reloadFailed = true;
	const detail = redactMcpText(error instanceof Error ? error.message : String(error));
	log.warn(`MCP configuration reload failed for ${sessionId}: ${detail}`);
	showPendingMcpReload(sessionId);
	notifyExtUi(
		sessionId,
		`This chat could not apply its MCP configuration — reload it to retry. ${detail}`,
		"error",
	);
}

export async function reconcileMcpSessions(
	sessionIds: readonly string[],
): Promise<Record<string, SessionReloadDisposition>> {
	const dispositions: Record<string, SessionReloadDisposition> = {};
	for (const sessionId of sessionIds) {
		if (!hasFailedMcpReload(sessionId) && pendingMcpReload(sessionId).size === 0) continue;
		try {
			const disposition = await requestSessionReload(sessionId);
			dispositions[sessionId] = disposition;
			if (disposition === "deferred") showPendingMcpReload(sessionId);
		} catch {}
	}
	return dispositions;
}

export function watchUserMcpConfig(): () => void {
	const agentDir = getAgentDir();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let watcher: FSWatcher | undefined;
	let stopped = false;
	let retryMs = USER_CONFIG_DEBOUNCE_MS;
	const restart = () => {
		watcher?.close();
		watcher = undefined;
		if (stopped || retry !== undefined) return;
		retry = setTimeout(() => {
			retry = undefined;
			start();
		}, retryMs);
		retryMs = Math.min(retryMs * 2, 5_000);
	};
	const start = () => {
		if (stopped) return;
		try {
			mkdirSync(agentDir, { recursive: true });
			watcher = watch(agentDir, (event, filename) => {
				if (filename !== null && filename !== "mcp.json" && filename !== basename(agentDir)) {
					return;
				}
				if (event === "rename") restart();
				clearTimeout(timer);
				timer = setTimeout(
					() => void reconcileMcpSessions(liveSessionIdsOf()),
					USER_CONFIG_DEBOUNCE_MS,
				);
			});
			watcher.on("error", restart);
			retryMs = USER_CONFIG_DEBOUNCE_MS;
			void reconcileMcpSessions(liveSessionIdsOf());
		} catch {
			restart();
		}
	};
	start();
	return () => {
		stopped = true;
		clearTimeout(timer);
		clearTimeout(retry);
		watcher?.close();
	};
}

export function watchMcpStatus(sessionId: string): void {
	trackedOf(sessionId);
}

function trackedOf(sessionId: string): Tracked {
	const existing = tracked.get(sessionId);
	if (existing) return existing;
	const state: Tracked = {
		generation: 0,
		servers: [],
		transports: new Map(),
		resourcesKey: "[]",
		reloadFailed: false,
	};
	tracked.set(sessionId, state);
	return state;
}

export async function refreshMcpStatus(
	sessionId: string,
	waitMs: number,
): Promise<McpStatusSnapshot | null> {
	const before = mcpSessionView(sessionId);
	if (!before) return null;
	trackedOf(sessionId);
	if (waitMs > 0 && before.runtime.some((server) => server.state === "starting")) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			before.startup(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, waitMs);
			}),
		]);
		clearTimeout(timer);
	}
	const view = mcpSessionView(sessionId);
	if (!view) return null;
	apply(sessionId, reportMcpRuntime(view.runtime), false);
	return snapshotOf(sessionId);
}

export async function reconnectMcpServer(sessionId: string, name: string): Promise<void> {
	const view = mcpSessionView(sessionId);
	if (!view) throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
	try {
		await view.reconnect(name);
	} catch (error) {
		throw new Error(redactMcpText(error instanceof Error ? error.message : String(error)));
	}
}

export function scheduleMcpStatusRefresh(sessionId: string): void {
	void refreshMcpStatus(sessionId, 0);
}

export function forgetMcpStatus(sessionId: string): void {
	tracked.delete(sessionId);
}

export async function listMcpServers(options: {
	workspaceId: string;
	cwd: string;
	project: Pick<Project, "piResourceTrust" | "mcpApprovals" | "mcpOverrides"> | undefined;
	waitMs: number;
}): Promise<McpListResult> {
	const sessionIds = liveSessionIdsOf(options.workspaceId);
	const projectTrusted = options.project?.piResourceTrust === "granted";
	const snapshots = await Promise.all(
		sessionIds.map((sessionId) => refreshMcpStatus(sessionId, options.waitMs)),
	);
	const files = { agentDir: getAgentDir(), cwd: options.cwd, projectTrusted };
	const configErrors = summarizeMcpConfigErrors(files);
	return {
		servers: summarizeMcpServers({ ...files, policy: mcpPolicyOf(options.project) }),
		statuses: snapshots.filter((snapshot): snapshot is McpStatusSnapshot => snapshot !== null),
		...(configErrors.length > 0 ? { configErrors } : {}),
	};
}

function readBounded(path: string): { text: string; truncated: boolean } {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const buffer = Buffer.alloc(Math.min(size, READ_OUTPUT_MAX_BYTES));
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		return { text: buffer.subarray(0, read).toString("utf8"), truncated: size > read };
	} finally {
		closeSync(fd);
	}
}

export async function readMcpToolOutput(
	workspaceId: string,
	sessionId: string,
	toolCallId: string,
	cwd: string,
): Promise<McpReadOutputResult> {
	const { messages } = await getSessionMessages(sessionId, workspaceId, cwd);
	const result = messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (result?.role !== "toolResult" || !isMcpResultTool(result.toolName)) {
		return { available: false, reason: "unavailable" };
	}
	const details = result.details as { fullOutputPath?: unknown } | undefined;
	const recorded = details?.fullOutputPath;
	if (typeof recorded !== "string") return { available: false, reason: "unavailable" };
	let path = recorded;
	if (recorded.startsWith(ARTIFACT_URL)) {
		const artifact = await mcpSessionView(sessionId)?.artifact(recorded.slice(ARTIFACT_URL.length));
		if (!artifact) return { available: false, reason: "expired" };
		if ("text" in artifact) return { available: true, ...boundedText(artifact.text) };
		path = artifact.path;
	}
	if (!isAbsolute(path)) return { available: false, reason: "unavailable" };
	try {
		return { available: true, ...readBounded(path) };
	} catch {
		return { available: false, reason: "expired" };
	}
}

function boundedText(text: string): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= READ_OUTPUT_MAX_BYTES) return { text, truncated: false };
	return { text: bytes.subarray(0, READ_OUTPUT_MAX_BYTES).toString("utf8"), truncated: true };
}
