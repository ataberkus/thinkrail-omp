import { createReadStream, existsSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type AgentMessage, TERMINAL_TOOL_RESULT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionCommandContext,
	type ExtensionError,
	type ExtensionUIContext,
	getAgentDir,
	type PromptOptions,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { cfgLegacyShellCommandPrefix } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { isUserAuthoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { waitForSessionSettlement } from "@oh-my-pi/pi-coding-agent/session/session-settle";
import type {
	AgentSettlement,
	ImageContent,
	PiEvent,
	QueuedMessageContent,
	QueueLane,
	RefreshedModels,
	RemovedQueuedMessage,
	ReviewFixDetails,
	SessionCreatedPayload,
	SessionDeletedPayload,
	SessionEventPayload,
	SessionQueueContent,
	SessionQueueState,
	SessionState,
	SessionStateRecord,
	SessionStats,
	SessionSummary,
	SlashCommandInfo,
	ThinkingLevel,
	TranscriptMessage,
	WireModel,
	WireModelAuth,
} from "@thinkrail/contracts";
import {
	canMarkCompletionUnread,
	firstPromptOfTexts,
	normalizeSessionTitle,
	sameModel,
	TODO_REVIEW_FIX_CUSTOM_TYPE,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	type BackgroundCommands,
	createBackgroundCommands,
	createBackgroundCommandsExtension,
} from "pi-background-commands";
import type { ParentContext } from "pi-delegation";
import { RECURSION_GUARD_TOOLS, type Subagents } from "pi-subagents";
import { interactiveTools, registryToolOwner, serverExtensions } from "../extensions";
import { logger } from "../log";
import {
	dataDir,
	loadSessionLifecycle,
	loadSessionReceipts,
	SESSION_LIFECYCLE_VERSION,
	type SessionLifecycle,
	type SessionMetadataLoad,
	type SessionReceipts,
	saveSessionLifecycle,
	saveSessionReceipts,
} from "../persistence";
import { trashFile } from "../trash";
import { publishSessionResourcesChanged } from "./chatResources";
import {
	disposeSessionChildren,
	hasLiveSessionChildren,
	reconcileSessionSubagentUsage,
	removeWorkspaceDelegation,
	stopSessionChildren,
	subagentsFor,
} from "./delegation";
import {
	buildSessionResources,
	disabledExtensions,
	promptTemplateSourceInfo,
	toSkillCommands,
} from "./extensions";
import {
	createMcpSessionHost,
	type HostMcpServerConfig,
	type McpProjectPolicy,
	type McpRuntimeStatus,
	type McpSessionHost,
	mcpPolicyOf,
} from "./mcp";
import {
	assertMcpServerDisablableInChat,
	forgetMcpStatus,
	hasFailedMcpReload,
	reconcileMcpSessions,
	recordMcpReloadFailure,
	restartMcpStatus,
	scheduleMcpStatusRefresh,
	showPendingMcpReload,
	watchMcpStatus,
} from "./mcpSessions";
import { refreshModelListings } from "./modelAvailability";
import { preferredDefaultModel } from "./modelDefaults";
import { PiSessionFormatError, upgradePiSessionFile } from "./piMigration";
import {
	getPiRuntimeGeneration,
	type PiRuntimeGeneration,
	refreshCatalogs,
	settledAvailableModels,
} from "./piRuntime";
import { type HostSessionSettings, loadHostSettings } from "./piSettings";
import {
	clampThinkingLevel,
	engineThinkingLevel,
	supportedThinkingLevels,
	wireThinkingLevel,
} from "./piThinking";
import { catalogProviderAuth } from "./providerAuth";
import { REQUEST_REVIEW_TOOL_NAME } from "./requestReviewTool";
import {
	type CompactionReason,
	compactionReasonOf,
	type HostSessionEvent,
	projectSessionEvent,
} from "./sessionEventProjection";
import { repairDanglingToolCalls } from "./sessionRepair";
import { deriveSessionState } from "./sessionState";
import type { SkillAdmissionContext } from "./skillAdmission";
import {
	assessRespondability,
	buildToolResponseMessage,
	createToolResponseWaiters,
	describeToolResponse,
	hasPendingToolResult,
	RESPONDABILITY_ERRORS,
	type ToolResponseWaiters,
	toolResponseSessionServices,
} from "./toolResponses";
import { usagePurpose } from "./usagePurpose";
import {
	cancelExtUiForSession,
	createWebUiContext,
	notifyExtensionError,
	notifyExtUi,
	pendingExtUiDialog,
	selectForToolCall,
	setExtUiStateChanged,
} from "./webUiContext";
import { wireTranscriptMessages } from "./wireMessages";

const log = logger("agent");

interface QueuedPrompt {
	text: string;
	images?: ImageContent[];
	group: readonly AgentMessage[];
}

interface BuiltEngineSession {
	session: AgentSession;
	loadedRegistry: Set<string>;
}

type SessionBuilder = (
	sessionManager: SessionManager,
	settings: HostSessionSettings,
	model?: CatalogModel,
) => Promise<BuiltEngineSession>;

interface Entry {
	subagents: Subagents;
	commands: BackgroundCommands;
	unsubscribeCommands: () => void;
	resourceCascade?: Promise<void>;
	childrenClosed?: Promise<void>;
	shutdown?: { session: AgentSession; settled: Promise<void> } | undefined;
	resourcesClosing: boolean;
	session: AgentSession;
	settings: HostSessionSettings;
	build: SessionBuilder;
	loadedRegistry: Set<string>;
	generation: PiRuntimeGeneration;
	unsubscribe: () => void;
	emit: (event: HostSessionEvent) => void;
	runEpoch: number;
	runActive: boolean;
	lastTerminal: AgentSettlement | null;
	compactionReason: CompactionReason;
	toolPolicy: Promise<void>;
	workspaceId: string;
	lastSettlement: AgentSettlement | null | undefined;
	queuedPrompts: WeakMap<AgentMessage, QueuedPrompt>;
	manualCompactionInProgress: boolean;
	piCompactionInProgress: boolean;
	reloadPending: boolean;
	reloadRunning: Promise<void> | null;
	preflightReleases: Set<() => void>;
	heldReservations: Set<() => void>;
	disposed: boolean;
	registered: boolean;
	subagentToolsRefreshPending: boolean;
	reviewToolRefreshPending: boolean;
	extensionToolsRefreshPending: boolean;
	withheldExtensionTools: Set<string>;
	nudgePromptPending: boolean;
	settleWaiters: Set<() => void>;
	lastPublishedState: string | null;
	firstPrompt: string | null;
	firstPromptScanned: number;
	toolResponseWaiters: ToolResponseWaiters;
	mcpHost: McpSessionHost;
}

const sessions = new Map<string, Entry>();
let sessionLifecycleGeneration = 0;
const workspaceLifecycleGenerations = new Map<string, number>();
const closingWorkspaces = new Map<string, number>();
const pendingSessionPreparations = new Map<string, Set<Promise<unknown>>>();
const sessionTeardowns = new Map<string, Promise<void>>();
const tearingDownEntries = new Map<string, Entry>();

interface WorkspaceLifecycleToken {
	global: number;
	workspace: number;
}

function captureWorkspaceLifecycle(workspaceId: string): WorkspaceLifecycleToken {
	return {
		global: sessionLifecycleGeneration,
		workspace: workspaceLifecycleGenerations.get(workspaceId) ?? 0,
	};
}

function workspaceAcceptsSessions(workspaceId: string, token: WorkspaceLifecycleToken): boolean {
	return (
		token.global === sessionLifecycleGeneration &&
		token.workspace === (workspaceLifecycleGenerations.get(workspaceId) ?? 0) &&
		!closingWorkspaces.has(workspaceId)
	);
}

function trackSessionPreparation<T>(
	workspaceId: string,
	token: WorkspaceLifecycleToken,
	operation: () => Promise<T>,
): Promise<T> {
	if (!workspaceAcceptsSessions(workspaceId, token))
		return Promise.reject(new Error(`Workspace is unavailable: ${workspaceId}`));
	const pending = operation();
	let preparations = pendingSessionPreparations.get(workspaceId);
	if (!preparations) {
		preparations = new Set();
		pendingSessionPreparations.set(workspaceId, preparations);
	}
	const scope = preparations;
	scope.add(pending);
	return pending.finally(() => {
		scope.delete(pending);
		if (scope.size === 0 && pendingSessionPreparations.get(workspaceId) === scope)
			pendingSessionPreparations.delete(workspaceId);
	});
}

let sessionMetadataRoot: string | null = null;
let sessionLifecycle: SessionLifecycle | null = null;
let sessionReceipts: SessionReceipts | null | undefined;

function loadedSessionMetadata<T>(load: SessionMetadataLoad<T>): T | null {
	if (load.kind === "loaded") return load.value;
	if (load.kind === "set-aside") {
		log.warn(
			`${load.file} was unreadable; ${load.setAsidePath ? `moved it to ${load.setAsidePath}` : "could not move it aside"} and rebuilding session state`,
			load.error,
		);
	}
	return null;
}

function ensureSessionMetadata(): void {
	const root = dataDir();
	if (sessionMetadataRoot === root && sessionLifecycle) return;
	const loadedLifecycle = loadedSessionMetadata(loadSessionLifecycle());
	const loadedReceipts = loadedSessionMetadata(loadSessionReceipts());
	sessionMetadataRoot = root;
	sessionLifecycle = loadedLifecycle ?? {
		version: SESSION_LIFECYCLE_VERSION,
		completionBySession: {},
		cancelledRunBySession: {},
	};
	sessionReceipts = loadedLifecycle ? loadedReceipts : null;
}

function lifecycle(): SessionLifecycle {
	ensureSessionMetadata();
	if (!sessionLifecycle) throw new Error("Session lifecycle metadata is unavailable");
	return sessionLifecycle;
}

function receipts(): SessionReceipts | null {
	ensureSessionMetadata();
	return sessionReceipts ?? null;
}

function omitMetadataKey<T>(record: Record<string, T>, key: string): Record<string, T> {
	const { [key]: _removed, ...rest } = record;
	return rest;
}

function removeSessionStateMetadata(sessionId: string): void {
	const currentLifecycle = lifecycle();
	const nextLifecycle: SessionLifecycle = {
		...currentLifecycle,
		completionBySession: omitMetadataKey(currentLifecycle.completionBySession, sessionId),
		cancelledRunBySession: omitMetadataKey(currentLifecycle.cancelledRunBySession, sessionId),
	};
	saveSessionLifecycle(nextLifecycle);
	sessionLifecycle = nextLifecycle;
	const currentReceipts = receipts();
	if (currentReceipts) {
		const nextReceipts: SessionReceipts = {
			...currentReceipts,
			handledCompletionBySession: omitMetadataKey(
				currentReceipts.handledCompletionBySession,
				sessionId,
			),
		};
		saveSessionReceipts(nextReceipts);
		sessionReceipts = nextReceipts;
	}
}

export async function usePiRuntime<T>(
	operation: (
		runtime: PiRuntimeGeneration["runtime"],
		generation: PiRuntimeGeneration,
	) => Promise<T> | T,
): Promise<T> {
	const generation = await getPiRuntimeGeneration();
	return operation(generation.runtime, generation);
}

const deletedSessions = new Map<string, string>();

const deletingSessions = new Map<string, { workspaceId: string; done: Promise<void> }>();

function isSessionDeleted(sessionId: string, workspaceId: string): boolean {
	return deletedSessions.get(sessionId) === workspaceId;
}

function sessionIsTearingDown(sessionId: string): boolean {
	return sessionTeardowns.has(sessionId);
}

function sessionCanAttach(sessionId: string, workspaceId: string): boolean {
	return (
		!isSessionDeleted(sessionId, workspaceId) &&
		!sessionIsTearingDown(sessionId) &&
		!closingWorkspaces.has(workspaceId)
	);
}

export type { SessionEventPayload };

let publish: (payload: SessionEventPayload) => void = () => {};
export function setSessionPublisher(fn: (payload: SessionEventPayload) => void): void {
	publish = fn;
}

let publishCreated: (payload: SessionCreatedPayload) => void = () => {};
export function setSessionCreatedPublisher(fn: (payload: SessionCreatedPayload) => void): void {
	publishCreated = fn;
}

let publishDeleted: (payload: SessionDeletedPayload) => void = () => {};
export function setSessionDeletedPublisher(fn: (payload: SessionDeletedPayload) => void): void {
	publishDeleted = fn;
}

let publishState: (record: SessionStateRecord) => void = () => {};
export function setSessionStatePublisher(fn: (record: SessionStateRecord) => void): void {
	publishState = fn;
	setExtUiStateChanged((sessionId) => {
		const entry = sessions.get(sessionId);
		if (entry) publishEntryState(entry);
	});
}

let resolveProjectId: (workspaceId: string) => string | null = () => null;
export function setSessionProjectResolver(fn: (workspaceId: string) => string | null): void {
	resolveProjectId = fn;
}

function effectivePendingCount(entry: Entry): number {
	return entry.session.queuedMessageCount;
}

function persistedCompletion(sessionId: string) {
	const stateReceipts = receipts();
	return stateReceipts?.baselineComplete
		? (lifecycle().completionBySession[sessionId] ?? null)
		: undefined;
}

function backgroundWorkActive(entry: Entry): boolean {
	return (
		entry.commands
			.list()
			.some((command) => command.status === "running" || command.status === "stopping") ||
		hasLiveSessionChildren(entry.workspaceId, entry.session.sessionId)
	);
}

function stateFromEntry(entry: Entry): SessionState {
	const sessionId = entry.session.sessionId;
	return deriveSessionState({
		entries: entry.session.sessionManager.getBranch(),
		isStreaming: entry.session.isStreaming,
		pendingMessageCount: effectivePendingCount(entry),
		backgroundWorkActive: backgroundWorkActive(entry),
		lastSettlement: entry.lastSettlement,
		lifecycleCompletion:
			entry.lastSettlement === undefined ? persistedCompletion(sessionId) : undefined,
		liveInteraction: entry.toolResponseWaiters.currentInteraction(),
		liveRegistry: true,
		interactiveTools: enabledInteractiveTools(),
		pendingDialog: pendingExtUiDialog(sessionId),
		handledCompletionId: receipts()?.handledCompletionBySession[sessionId],
		cancelledRunId: lifecycle().cancelledRunBySession[sessionId],
	});
}

function enabledInteractiveTools() {
	const disabled = disabledExtensions();
	return interactiveTools((name) => disabled.has(name));
}

function* userTextsOf(entries: readonly SessionEntry[]): Generator<string> {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const { content } = entry.message;
		yield typeof content === "string"
			? content
			: content
					.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
					.map((part) => part.text)
					.join("");
	}
}

function firstPromptOf(entries: readonly SessionEntry[]): { firstPrompt?: string } {
	const head = firstPromptOfTexts(userTextsOf(entries));
	return head ? { firstPrompt: head } : {};
}

function entryFirstPrompt(entry: Entry): { firstPrompt?: string } {
	if (entry.firstPrompt === null) {
		const manager = entry.session.sessionManager;
		const count = manager.getEntries().length;
		if (count !== entry.firstPromptScanned) {
			const head = firstPromptOfTexts(
				userTextsOf(manager.getEntries().slice(entry.firstPromptScanned)),
			);
			entry.firstPrompt = head ?? null;
			entry.firstPromptScanned = count;
		}
	}
	return entry.firstPrompt === null ? {} : { firstPrompt: entry.firstPrompt };
}

function publishEntryState(entry: Entry): void {
	if (sessions.get(entry.session.sessionId) !== entry) return;
	const projectId = resolveProjectId(entry.workspaceId);
	if (!projectId) return;
	const state = stateFromEntry(entry);
	const firstPrompt = entryFirstPrompt(entry);
	const serialized = JSON.stringify({ state, ...firstPrompt });
	if (entry.lastPublishedState === serialized) return;
	entry.lastPublishedState = serialized;
	publishState({
		sessionId: entry.session.sessionId,
		workspaceId: entry.workspaceId,
		projectId,
		state,
		...firstPrompt,
	});
}

const scheduledStatePublishes = new Set<Entry>();

function scheduleEntryStatePublish(entry: Entry): void {
	if (scheduledStatePublishes.has(entry)) return;
	scheduledStatePublishes.add(entry);
	setImmediate(() => {
		scheduledStatePublishes.delete(entry);
		publishEntryState(entry);
	});
}

export function scheduleSessionStatePublish(sessionId: string): void {
	const entry = sessions.get(sessionId);
	if (entry) scheduleEntryStatePublish(entry);
}

function stateFromDisk(sessionId: string, manager: SessionManager, legacy = false): SessionState {
	return deriveSessionState({
		entries: manager.getBranch(),
		isStreaming: false,
		pendingMessageCount: 0,
		backgroundWorkActive: false,
		lastSettlement: undefined,
		lifecycleCompletion: legacy ? undefined : persistedCompletion(sessionId),
		liveInteraction: null,
		liveRegistry: false,
		interactiveTools: enabledInteractiveTools(),
		pendingDialog: null,
		handledCompletionId: receipts()?.handledCompletionBySession[sessionId],
		cancelledRunId: lifecycle().cancelledRunBySession[sessionId],
	});
}

export function getSessionState(sessionId: string): SessionState {
	return stateFromEntry(mustGetEntry(sessionId));
}

function stateRecordForEntry(entry: Entry): SessionStateRecord {
	const projectId = resolveProjectId(entry.workspaceId);
	if (!projectId) throw new Error(`Unknown workspace: ${entry.workspaceId}`);
	return {
		sessionId: entry.session.sessionId,
		workspaceId: entry.workspaceId,
		projectId,
		state: stateFromEntry(entry),
		...entryFirstPrompt(entry),
	};
}

export function acknowledgeCompletion(
	sessionId: string,
	completionId: string,
): { acknowledged: boolean; record: SessionStateRecord } {
	const entry = mustGetEntry(sessionId);
	const currentReceipts = receipts();
	if (!currentReceipts?.baselineComplete) throw new Error("Session state is not initialized");
	const currentState = stateFromEntry(entry);
	if (currentState.completion?.completionId !== completionId || !currentState.completionUnread) {
		return { acknowledged: false, record: stateRecordForEntry(entry) };
	}
	const nextReceipts: SessionReceipts = {
		...currentReceipts,
		handledCompletionBySession: {
			...currentReceipts.handledCompletionBySession,
			[sessionId]: completionId,
		},
	};
	saveSessionReceipts(nextReceipts);
	sessionReceipts = nextReceipts;
	publishEntryState(entry);
	return { acknowledged: true, record: stateRecordForEntry(entry) };
}

export function nudgeSession(
	sessionId: string,
	text: string,
	images?: ImageContent[],
): {
	disposition: "needs_input" | "queued" | "prompted";
	send: () => Promise<void>;
} {
	const entry = mustGetEntry(sessionId);
	const state = stateFromEntry(entry);
	if (state.needsInput) return { disposition: "needs_input", send: () => Promise.resolve() };
	if (state.execution === "running" || entry.nudgePromptPending) {
		return {
			disposition: "queued",
			send: async () => {
				const input = await applyInputHandlers(entry, text, images);
				if (!input) return;
				await queuePrompt(entry, input.text, input.images, (onPromptQueued) =>
					entry.session.followUp(input.text, input.images, { onPromptQueued }),
				);
			},
		};
	}
	entry.nudgePromptPending = true;
	return {
		disposition: "prompted",
		send: async () => {
			try {
				await promptSession(sessionId, text, images);
			} finally {
				entry.nudgePromptPending = false;
			}
		},
	};
}

function recordSettlement(entry: Entry, terminal: AgentSettlement | null): void {
	const sessionId = entry.session.sessionId;
	const observed = deriveSessionState({
		entries: entry.session.sessionManager.getBranch(),
		isStreaming: false,
		pendingMessageCount: effectivePendingCount(entry),
		backgroundWorkActive: false,
		lastSettlement: terminal,
		lifecycleCompletion: undefined,
		liveInteraction: entry.toolResponseWaiters.currentInteraction(),
		liveRegistry: true,
		interactiveTools: enabledInteractiveTools(),
		pendingDialog: pendingExtUiDialog(sessionId),
		handledCompletionId: receipts()?.handledCompletionBySession[sessionId],
		cancelledRunId: lifecycle().cancelledRunBySession[sessionId],
	});
	if (!observed.runId || !observed.completion) return;
	const current = lifecycle();
	const next: SessionLifecycle = {
		...current,
		completionBySession: {
			...current.completionBySession,
			[sessionId]: { runId: observed.runId, completion: observed.completion },
		},
	};
	saveSessionLifecycle(next);
	sessionLifecycle = next;
}

function markCancelledRun(entry: Entry): void {
	const state = stateFromEntry(entry);
	if (!state.runId) return;
	const current = lifecycle();
	if (current.cancelledRunBySession[entry.session.sessionId] === state.runId) return;
	const next: SessionLifecycle = {
		...current,
		cancelledRunBySession: {
			...current.cancelledRunBySession,
			[entry.session.sessionId]: state.runId,
		},
	};
	sessionLifecycle = next;
	try {
		saveSessionLifecycle(next);
	} catch (error) {
		log.warn(
			`session cancellation state was not persisted for ${entry.session.sessionId}`,
			error as Error,
		);
	}
}

let sessionManagerFactory: (cwd: string) => SessionManager = (cwd) => SessionManager.create(cwd);
export function setSessionManagerFactory(factory: (cwd: string) => SessionManager): void {
	sessionManagerFactory = factory;
}

let skillAdmissionResolver: (workspaceId: string) => SkillAdmissionContext = () => ({
	trusted: false,
	piResourceTrusted: false,
	acknowledged: [],
	disabled: [],
	disabledGroups: [],
	overrides: {},
});
export function setSkillAdmissionResolver(
	resolver: (workspaceId: string) => SkillAdmissionContext,
): void {
	skillAdmissionResolver = resolver;
}

let mcpPolicyResolver: (workspaceId: string) => McpProjectPolicy = () => mcpPolicyOf(undefined);
export function setMcpPolicyResolver(resolver: (workspaceId: string) => McpProjectPolicy): void {
	mcpPolicyResolver = resolver;
}

type McpToolGrantWriter = (
	workspaceId: string,
	server: string,
	target: string,
	tool: string,
) => void;
let mcpToolGrantWriter: McpToolGrantWriter = () => {};
export function setMcpToolGrantWriter(writer: McpToolGrantWriter): void {
	mcpToolGrantWriter = writer;
}

function piResourceTrustFor(workspaceId: string): boolean {
	return skillAdmissionResolver(workspaceId).piResourceTrusted;
}

let subagentsEnabledResolver: (workspaceId: string) => boolean = () => true;
export function setSubagentsEnabledResolver(resolver: (workspaceId: string) => boolean): void {
	subagentsEnabledResolver = resolver;
}

function subagentsEnabled(workspaceId: string): boolean {
	try {
		return subagentsEnabledResolver(workspaceId);
	} catch {
		return false;
	}
}

function isSubagentTool(name: string): boolean {
	return RECURSION_GUARD_TOOLS.some((toolName) => toolName === name);
}

function applySubagentTools(entry: Entry): Promise<void> {
	entry.subagentToolsRefreshPending = false;
	return scheduleToolPolicy(entry);
}

export function refreshSubagentTools(workspaceId?: string): Promise<void> {
	const applied: Promise<void>[] = [];
	for (const entry of sessions.values()) {
		if (workspaceId !== undefined && entry.workspaceId !== workspaceId) continue;
		if (entry.session.isStreaming) entry.subagentToolsRefreshPending = true;
		else applied.push(applySubagentTools(entry));
	}
	return Promise.all(applied).then(() => {});
}

// Injected by the host (never an agent → settings edge, see agent/SPEC.md); default on. Gates the
// worker's in-session request_review tool live: `setActiveToolsByName` rebuilds the system prompt from
// only the active tools' guidelines, so toggling the tool off also drops its guidance. The Review button
// path (startPlanReview) is separate and unaffected.
let agentReviewEnabledResolver: (workspaceId: string) => boolean = () => true;
export function setAgentReviewEnabledResolver(resolver: (workspaceId: string) => boolean): void {
	agentReviewEnabledResolver = resolver;
}

function agentReviewEnabled(workspaceId: string): boolean {
	try {
		return agentReviewEnabledResolver(workspaceId);
	} catch {
		return false;
	}
}

function applyReviewTool(entry: Entry): void {
	entry.reviewToolRefreshPending = false;
	scheduleToolPolicy(entry);
}

export function refreshAgentReviewTool(workspaceId?: string): void {
	for (const entry of sessions.values()) {
		if (workspaceId !== undefined && entry.workspaceId !== workspaceId) continue;
		if (entry.session.isStreaming) entry.reviewToolRefreshPending = true;
		else applyReviewTool(entry);
	}
}

function nextEnabledTools(entry: Entry, enabled: readonly string[]): string[] {
	const disabled = disabledExtensions();
	const isOff = (tool: string): boolean => {
		const owner = registryToolOwner(tool);
		return owner !== undefined && disabled.has(owner) && entry.loadedRegistry.has(owner);
	};
	const registered = new Set(entry.session.getAllToolNames());
	for (const tool of enabled.filter(isOff)) entry.withheldExtensionTools.add(tool);
	const restored: string[] = [];
	for (const tool of entry.withheldExtensionTools) {
		if (registered.has(tool) && isOff(tool)) continue;
		entry.withheldExtensionTools.delete(tool);
		if (registered.has(tool) && !enabled.includes(tool)) restored.push(tool);
	}
	const kept = enabled.filter(
		(tool) => !isOff(tool) && !isSubagentTool(tool) && tool !== REQUEST_REVIEW_TOOL_NAME,
	);
	return [
		...kept,
		...restored,
		...(subagentsEnabled(entry.workspaceId) ? RECURSION_GUARD_TOOLS : []),
		...(agentReviewEnabled(entry.workspaceId) ? [REQUEST_REVIEW_TOOL_NAME] : []),
	].filter((tool, index, all) => registered.has(tool) && all.indexOf(tool) === index);
}

function scheduleToolPolicy(entry: Entry): Promise<void> {
	const session = entry.session;
	entry.toolPolicy = entry.toolPolicy
		.then(async () => {
			if (entry.disposed || entry.session !== session) return;
			const enabled = session.getEnabledToolNames();
			const next = nextEnabledTools(entry, enabled);
			if (next.length === enabled.length && next.every((tool) => enabled.includes(tool))) return;
			await session.setActiveToolsByName(next);
		})
		.catch((error: unknown) => {
			if (!entry.disposed)
				log.warn(`tool selection was not applied for ${session.sessionId}`, error);
		});
	return entry.toolPolicy;
}

function applyExtensionTools(entry: Entry, { allowReload = true } = {}): void {
	entry.extensionToolsRefreshPending = false;
	void scheduleToolPolicy(entry);
	const { sessionId } = entry.session;
	if (allowReload && enabledExtensionMissing(entry, disabledExtensions())) {
		void requestSessionReload(sessionId).catch((error) => {
			if (!entry.disposed && !entry.resourcesClosing && !hasFailedMcpReload(sessionId)) {
				log.warn(`extension reload failed for ${sessionId}`, error as Error);
			}
		});
	}
}

function enabledExtensionMissing(entry: Entry, disabled: ReadonlySet<string>): boolean {
	return serverExtensions.some(
		({ extension }) =>
			(extension.extensions.length > 0 || extension.sessionExtensions !== undefined) &&
			!disabled.has(extension.name) &&
			!entry.loadedRegistry.has(extension.name),
	);
}

export function refreshExtensionTools(): void {
	for (const entry of sessions.values()) {
		if (entry.session.isStreaming) entry.extensionToolsRefreshPending = true;
		else applyExtensionTools(entry);
		scheduleEntryStatePublish(entry);
	}
}

function hasDeletionTombstone(sessionId: string): boolean {
	return deletedSessions.has(sessionId);
}

function mustGetEntry(sessionId: string): Entry {
	if (hasDeletionTombstone(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
	const entry = sessions.get(sessionId);
	if (!entry) throw new Error(`Unknown session: ${sessionId}`);
	return entry;
}

function mustGet(sessionId: string): AgentSession {
	return mustGetEntry(sessionId).session;
}

export function hasSession(sessionId: string): boolean {
	return sessions.has(sessionId) && !hasDeletionTombstone(sessionId);
}

export function getSessionWorkspaceId(sessionId: string): string | undefined {
	return sessions.get(sessionId)?.workspaceId;
}

export function getSessionRuntimeGeneration(sessionId: string): PiRuntimeGeneration | undefined {
	return hasSession(sessionId) ? sessions.get(sessionId)?.generation : undefined;
}

function transcriptMessages(session: AgentSession): TranscriptMessage[] {
	return wireTranscriptMessages(
		session.buildTranscriptSessionContext({
			collapseCompactedHistory: true,
			keepInFlightToolCalls: session.isStreaming,
		}).messages,
	);
}

export async function reloadSessionResources(sessionId: string): Promise<void> {
	const entry = mustGetEntry(sessionId);
	if (entry.reloadRunning) {
		await entry.reloadRunning;
		return;
	}
	const blocked = reloadBlockedReason(entry);
	if (blocked) throw new Error(`Can't reload while ${blocked} — try again after the turn.`);
	await runGatedReload(entry);
}

export type SessionReloadDisposition = "reloaded" | "deferred";

export async function requestSessionReload(sessionId: string): Promise<SessionReloadDisposition> {
	const entry = mustGetEntry(sessionId);
	if (entry.reloadRunning) {
		entry.reloadPending = true;
		await entry.reloadRunning;
		return "reloaded";
	}
	if (reloadBlockedReason(entry)) {
		entry.reloadPending = true;
		return "deferred";
	}
	await runGatedReload(entry);
	return "reloaded";
}

function reloadBlockedReason(entry: Entry): string | null {
	if (entry.disposed || entry.resourcesClosing) return "the chat is closing";
	if (entry.session.isStreaming || entry.session.hasAdmittedSubmission) return "the chat is busy";
	if (entry.preflightReleases.size > 0 || entry.heldReservations.size > 0) {
		return "a message is being admitted";
	}
	if (entry.manualCompactionInProgress || entry.piCompactionInProgress) {
		return "compaction is in progress";
	}
	return null;
}

function reconsiderPendingReload(entry: Entry): void {
	if (!entry.reloadPending || entry.reloadRunning || reloadBlockedReason(entry)) return;
	const { sessionId } = entry.session;
	void runGatedReload(entry).catch((error) => {
		if (
			sessions.get(sessionId) !== entry ||
			entry.disposed ||
			entry.resourcesClosing ||
			hasFailedMcpReload(sessionId)
		)
			return;
		log.warn(`deferred resource reload failed for ${sessionId}`, error as Error);
		notifyExtUi(
			sessionId,
			`This chat could not reload its resources after a settings change and still runs with the previous ones — close or reload it. ${(error as Error).message ?? String(error)}`,
			"error",
		);
	});
}

async function replaceEngineSession(entry: Entry, beforeSessionStart: () => void): Promise<void> {
	const previous = entry.session;
	const manager = previous.sessionManager;
	const file = manager.getSessionFile();
	const carried = manager.isSessionOnDisk() ? undefined : manager.cloneCurrentSession();
	entry.unsubscribe();
	entry.unsubscribe = () => {};
	await emitSessionShutdown(entry);
	beforeSessionStart();
	const reopen = async (): Promise<SessionManager> =>
		carried
			? carried.cloneCurrentSession()
			: file
				? SessionManager.open(file, undefined, undefined, { throwIfMissing: true })
				: manager.cloneCurrentSession();
	const reopened = await reopen();
	const settings = await loadHostSettings(reopened.getCwd(), piResourceTrustFor(entry.workspaceId));
	beforeSessionStart();
	let built: BuiltEngineSession;
	try {
		built = await entry.build(reopened, settings);
	} catch (error) {
		log.warn(
			`chat ${previous.sessionId} could not load its new resources; restoring the previous ones`,
			error,
		);
		beforeSessionStart();
		await adoptEngineSession(
			entry,
			await entry.build(await reopen(), entry.settings),
			entry.settings,
		);
		throw error;
	}
	await adoptEngineSession(entry, built, settings);
}

async function adoptEngineSession(
	entry: Entry,
	built: BuiltEngineSession,
	settings: HostSessionSettings,
): Promise<void> {
	if (entry.disposed || entry.resourcesClosing) {
		await Promise.allSettled([entry.mcpHost.shutdownEngine(), built.session.dispose()]);
		throw new Error("The chat is closing.");
	}
	entry.loadedRegistry = built.loadedRegistry;
	entry.session = built.session;
	entry.settings = settings;
	entry.shutdown = undefined;
	await attachEngineSession(entry);
}

function runGatedReload(entry: Entry): Promise<void> {
	if (entry.reloadRunning) return entry.reloadRunning;
	entry.reloadPending = false;
	const mcpWasLoaded = entry.mcpHost.loaded() !== null;
	const beforeSessionStart = () => {
		if (entry.disposed || entry.resourcesClosing) throw new Error("The chat is closing.");
	};
	entry.reloadRunning = (async () => {
		let reloaded = false;
		try {
			await replaceEngineSession(entry, beforeSessionStart);
			reloaded = true;
		} catch (error) {
			if (!entry.disposed && !entry.resourcesClosing) {
				recordMcpReloadFailure(entry.session.sessionId, error, mcpWasLoaded);
			}
			throw error;
		} finally {
			entry.reloadRunning = null;
			if (entry.disposed || entry.resourcesClosing) {
				entry.reloadPending = false;
			} else {
				applyExtensionTools(entry, { allowReload: false });
				entry.commands.flushCompletions();
				entry.subagents.flushCompletions();
				publishEntryState(entry);
				if (reloaded) {
					restartMcpStatus(entry.session.sessionId);
					reconsiderPendingReload(entry);
				}
			}
		}
	})();
	return entry.reloadRunning;
}

function admitRun(entry: Entry): void {
	if (entry.reloadRunning) {
		throw new Error("The chat is reloading its resources — try again in a moment.");
	}
}

function admitPreflight(entry: Entry, held = false): () => void {
	admitRun(entry);
	const reservations = held ? entry.heldReservations : entry.preflightReleases;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		reservations.delete(release);
		reconsiderPendingReload(entry);
	};
	reservations.add(release);
	return release;
}

function releasePreflights(entry: Entry): void {
	for (const release of [...entry.preflightReleases]) release();
}

export function buildSessionSettings(
	cwd: string,
	projectTrusted: boolean,
): Promise<HostSessionSettings> {
	return loadHostSettings(cwd, projectTrusted);
}

export type TrustReloadDisposition = SessionReloadDisposition | "failed";

export async function applyPiResourceTrust(
	workspaceIds: readonly string[],
): Promise<Record<string, TrustReloadDisposition>> {
	const scope = new Set(workspaceIds);
	const stale = [...sessions].filter(
		([, entry]) =>
			scope.has(entry.workspaceId) &&
			!entry.disposed &&
			!entry.resourcesClosing &&
			entry.settings.projectTrusted !== piResourceTrustFor(entry.workspaceId),
	);
	const dispositions: Record<string, TrustReloadDisposition> = {};
	for (const [sessionId, entry] of stale) {
		if (!piResourceTrustFor(entry.workspaceId))
			await stopSessionChildren(entry.workspaceId, sessionId, "user").settled;
		try {
			dispositions[sessionId] = await requestSessionReload(sessionId);
		} catch (error) {
			if (!entry.disposed && !entry.resourcesClosing && !hasFailedMcpReload(sessionId)) {
				log.warn(`trust reload failed for ${sessionId}`, error as Error);
			}
			dispositions[sessionId] = "failed";
		}
	}
	return dispositions;
}

export interface CreateSessionInput {
	cwd: string;
	workspaceId: string;
	model?: WireModel;
	thinkingLevel?: ThinkingLevel;
	/** True: an unresolvable `model` falls back to the default instead of throwing. */
	modelOptional?: boolean;
}

export interface CreateSessionResult {
	sessionId: string;
	model: WireModel | null;
	thinkingLevel: ThinkingLevel;
}

type CatalogModel = ReturnType<typeof settledAvailableModels>[number];

export function toWireModel(model: CatalogModel, auth?: WireModelAuth): WireModel {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		contextWindow: model.contextWindow ?? 0,
		reasoning: model.reasoning,
		thinkingLevels: supportedThinkingLevels(model),
		cost: { input: model.cost.input, output: model.cost.output },
		input: [...model.input],
		...(auth ? { auth } : {}),
	};
}

function sessionWireModel(
	model: CatalogModel,
	generation: Pick<PiRuntimeGeneration, "runtime" | "opaqueProviderIds">,
): WireModel {
	return toWireModel(model, catalogProviderAuth(generation, model.provider));
}

function resolveWireModel(
	runtime: PiRuntimeGeneration["runtime"],
	ref: Pick<WireModel, "provider" | "id">,
): CatalogModel {
	const available = settledAvailableModels(runtime);
	const match = available.find((model) => sameModel(model, ref));
	if (!match) throw new Error(`Unknown or unavailable model: ${ref.provider}/${ref.id}`);
	return match;
}

const RENAMED_PI_PROVIDERS: Readonly<Record<string, string>> = {
	"azure-openai-responses": "azure",
};

function resolvePersistedModel(
	runtime: PiRuntimeGeneration["runtime"],
	ref: Pick<WireModel, "provider" | "id">,
): CatalogModel {
	try {
		return resolveWireModel(runtime, ref);
	} catch (error) {
		const renamed = RENAMED_PI_PROVIDERS[ref.provider];
		if (!renamed) throw error;
		return resolveWireModel(runtime, { provider: renamed, id: ref.id });
	}
}

function sessionResult(entry: Entry): CreateSessionResult {
	const { session } = entry;
	return {
		sessionId: session.sessionId,
		model: session.model ? sessionWireModel(session.model, entry.generation) : null,
		thinkingLevel: wireThinkingLevel(session.thinkingLevel),
	};
}

function terminalOf(messages: readonly { role: string }[]): AgentSettlement | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && isAssistantMessage(message)) {
			return {
				stopReason: message.stopReason,
				...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
			};
		}
	}
	return null;
}

function isAssistantMessage(message: {
	role: string;
}): message is Extract<AgentSession["messages"][number], { role: "assistant" }> {
	return message.role === "assistant";
}

function scheduleSettle(entry: Entry, session: AgentSession): void {
	if (!entry.runActive) return;
	const epoch = entry.runEpoch;
	const current = () =>
		!entry.disposed && entry.session === session && entry.runActive && entry.runEpoch === epoch;
	void Bun.sleep(0)
		.then(() => Bun.sleep(0))
		.then(() => waitForSessionSettlement(session, { isCurrent: current }))
		.then((settled) => {
			if (!settled || !current()) return;
			entry.runActive = false;
			entry.emit({ type: "agent_settled", aborted: entry.lastTerminal?.stopReason === "aborted" });
		})
		.catch((error: unknown) => log.warn(`settle detection failed for ${session.sessionId}`, error));
}

function handleEngineEvent(entry: Entry, event: HostSessionEvent): void {
	const { session } = entry;
	const { sessionId } = session;
	if (event.type === "turn_end") entry.toolResponseWaiters.persistTurn(event.toolResults);
	if (event.type === "auto_compaction_start") {
		entry.piCompactionInProgress = true;
		entry.compactionReason = compactionReasonOf(event.reason);
	}
	if (event.type === "auto_compaction_end") {
		entry.piCompactionInProgress = false;
		reconsiderPendingReload(entry);
		entry.commands.flushCompletions();
		entry.subagents.flushCompletions();
	}
	if (event.type === "compaction_end") {
		entry.commands.flushCompletions();
		entry.subagents.flushCompletions();
	}
	if (event.type === "agent_start") {
		entry.lastSettlement = null;
		entry.lastTerminal = null;
		entry.runEpoch++;
		entry.runActive = true;
		releasePreflights(entry);
	}
	if (event.type === "agent_end") entry.lastTerminal = terminalOf(event.messages);
	const baseEvent = projectSessionEvent(event, entry.lastTerminal, entry.compactionReason);
	const projected = baseEvent?.type === "queue_update" ? queueUpdateEventOf(entry) : baseEvent;
	if (event.type === "agent_settled") {
		const terminal = entry.lastTerminal;
		entry.lastSettlement = terminal;
		try {
			recordSettlement(entry, terminal);
		} catch (error) {
			log.warn(`session state settlement was not persisted for ${sessionId}`, error as Error);
		}
		if (entry.subagentToolsRefreshPending) void applySubagentTools(entry);
		if (entry.reviewToolRefreshPending) applyReviewTool(entry);
		if (entry.extensionToolsRefreshPending) applyExtensionTools(entry);
		reconsiderPendingReload(entry);
		scheduleMcpStatusRefresh(sessionId);
		void reconcileMcpSessions([sessionId]);
	}
	if (sessions.get(sessionId) === entry) {
		if (projected) publish({ sessionId, event: projected });
		publishEntryState(entry);
	}
	if (event.type === "agent_settled") void entry.toolPolicy.then(() => releaseSettleWaiters(entry));
	if (event.type === "agent_end" && event.yielded !== false) scheduleSettle(entry, session);
}

function untilSettled(entry: Entry): Promise<void> {
	if (!entry.runActive || entry.disposed) return Promise.resolve();
	return new Promise((resolve) => entry.settleWaiters.add(resolve));
}

function releaseSettleWaiters(entry: Entry): void {
	const waiters = [...entry.settleWaiters];
	entry.settleWaiters.clear();
	for (const resolve of waiters) resolve();
}

function reportExtensionErrorFor(entry: Entry): (failure: ExtensionError) => void {
	return (failure) => {
		const { sessionId } = entry.session;
		const line = `extension ${failure.extensionPath} failed on ${failure.event}: ${failure.error}`;
		if (entry.disposed) {
			log.debug(line);
			return;
		}
		if (failure.stack) {
			const cause = new Error(failure.error);
			cause.stack = failure.stack;
			log.warn(line, cause);
		} else {
			log.warn(line);
		}
		if (!entry.registered || sessions.get(sessionId) === entry)
			notifyExtensionError(sessionId, failure);
	};
}

async function attachEngineSession(entry: Entry): Promise<void> {
	const session = entry.session;
	const manager = session.sessionManager;
	const live = () => entry.session === session && !entry.disposed;
	const unsubscribeEvents = session.subscribe((event) => {
		if (live()) handleEngineEvent(entry, event);
	});
	const onEntryAppended = (appended: SessionEntry) => {
		if (live()) handleEngineEvent(entry, { type: "entry_appended", entry: appended });
	};
	manager.onEntryAppended = onEntryAppended;
	const unsubscribeName = manager.onSessionNameChanged(() => {
		if (live())
			handleEngineEvent(entry, { type: "session_info_changed", name: manager.getSessionName() });
	});
	const unsubscribeRunState = session.subscribeRunState((state) => {
		if (state === "idle" && live()) scheduleSettle(entry, session);
	});
	entry.unsubscribe = () => {
		unsubscribeEvents();
		unsubscribeName();
		unsubscribeRunState();
		if (manager.onEntryAppended === onEntryAppended) manager.onEntryAppended = () => {};
	};
	const reportExtensionError = reportExtensionErrorFor(entry);
	await initializeExtensions(session, {
		mode: "rpc",
		uiContext: createWebUiContext(session.sessionId, () => soleRunningToolCall(entry.session)),
		reportRuntimeError: reportExtensionError,
		reportSendError: (action, error) =>
			reportExtensionError({
				extensionPath: action,
				event: "send",
				error: error.message,
				...(error.stack ? { stack: error.stack } : {}),
			}),
	});
	if (entry.disposed || entry.resourcesClosing) throw new Error("The chat is closing.");
	entry.mcpHost.attach(session);
}

function soleRunningToolCall(session: AgentSession): string | undefined {
	if (!session.isStreaming) return undefined;
	const { streamMessage, pendingToolCalls } = session.agent.state;
	const messages = streamMessage
		? [...session.agent.state.messages, streamMessage]
		: session.agent.state.messages;
	const outstanding = new Set(pendingToolCalls);
	const answered = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult") answered.add(message.toolCallId);
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && !answered.has(block.id)) outstanding.add(block.id);
		}
		break;
	}
	if (outstanding.size !== 1) return undefined;
	const [toolCallId] = outstanding;
	return toolCallId;
}

function abandonPreparedEntry(entry: Entry): void {
	const { sessionId } = entry.session;
	cancelExtUiForSession(sessionId);
	forgetMcpStatus(sessionId);
	entry.toolResponseWaiters.abandon();
	releaseSettleWaiters(entry);
	entry.unsubscribe();
	entry.unsubscribeCommands();
	entry.disposed = true;
	clearEntryQueue(entry);
	void shutdownEngine(entry);
}

interface EngineSessionParts {
	workspaceId: string;
	generation: PiRuntimeGeneration;
	commands: BackgroundCommands;
	subagents: Subagents;
	toolResponseWaiters: ToolResponseWaiters;
	mcpHost: McpSessionHost;
}

function newEntry(
	parts: EngineSessionParts,
	built: BuiltEngineSession,
	settings: HostSessionSettings,
	build: SessionBuilder,
): Entry {
	const entry: Entry = {
		...parts,
		resourcesClosing: false,
		unsubscribeCommands: () => {},
		session: built.session,
		settings,
		build,
		loadedRegistry: built.loadedRegistry,
		unsubscribe: () => {},
		emit: () => {},
		runEpoch: 0,
		runActive: false,
		lastTerminal: null,
		compactionReason: "threshold",
		toolPolicy: Promise.resolve(),
		lastSettlement: undefined,
		queuedPrompts: new WeakMap(),
		manualCompactionInProgress: false,
		piCompactionInProgress: false,
		reloadPending: false,
		reloadRunning: null,
		preflightReleases: new Set(),
		heldReservations: new Set(),
		disposed: false,
		registered: false,
		subagentToolsRefreshPending: false,
		reviewToolRefreshPending: false,
		extensionToolsRefreshPending: false,
		withheldExtensionTools: new Set(),
		nudgePromptPending: false,
		settleWaiters: new Set(),
		lastPublishedState: null,
		firstPrompt: null,
		firstPromptScanned: 0,
	};
	entry.emit = (event) => handleEngineEvent(entry, event);
	entry.unsubscribeCommands = parts.commands.onChange(() => {
		const { sessionId } = entry.session;
		if (canUseSessionResources(sessionId, entry.workspaceId))
			publishSessionResourcesChanged(entry.workspaceId, sessionId);
		scheduleEntryStatePublish(entry);
	});
	return entry;
}

async function registerSession(
	entry: Entry,
	lifecycleToken: WorkspaceLifecycleToken,
	announceCreation = false,
): Promise<CreateSessionResult> {
	const { session, workspaceId } = entry;
	const { sessionId } = session;
	try {
		watchMcpStatus(sessionId);
		await attachEngineSession(entry);
		if (!sessionCanAttach(sessionId, workspaceId)) throw new Error(`Unknown session: ${sessionId}`);
	} catch (error) {
		abandonPreparedEntry(entry);
		throw error;
	}
	if (!workspaceAcceptsSessions(workspaceId, lifecycleToken) || sessionIsTearingDown(sessionId)) {
		abandonPreparedEntry(entry);
		throw new Error(`Workspace is unavailable: ${workspaceId}`);
	}
	entry.registered = true;
	sessions.set(sessionId, entry);
	if (entry.settings.projectTrusted !== piResourceTrustFor(workspaceId))
		await runGatedReload(entry);
	applyExtensionTools(entry);
	restartMcpStatus(sessionId);
	entry.commands.flushCompletions();
	entry.subagents.flushCompletions();
	reconcileSubagentUsageInBackground(workspaceId, sessionId);
	log.debug(`session ${sessionId} attached (workspace ${workspaceId})`);
	if (announceCreation) publishCreated(summaryOf(sessionId, entry));
	publishEntryState(entry);
	return sessionResult(entry);
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
	const lifecycleToken = captureWorkspaceLifecycle(input.workspaceId);
	const generation = await getPiRuntimeGeneration();
	let model: CatalogModel | undefined;
	if (input.model) {
		try {
			model = resolveWireModel(generation.runtime, input.model);
		} catch (err) {
			if (!input.modelOptional) throw err;
		}
	}
	const cwd = resolve(input.cwd);
	return createParentSession(
		{
			cwd,
			sessionManager: sessionManagerFactory(cwd),
			...(model ? { model } : {}),
			...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		},
		input.workspaceId,
		generation,
		lifecycleToken,
		true,
	);
}

interface ParentSessionOptions {
	cwd: string;
	sessionManager: SessionManager;
	model?: CatalogModel;
	thinkingLevel?: ThinkingLevel;
}

function createParentSession(
	options: ParentSessionOptions,
	workspaceId: string,
	generation: PiRuntimeGeneration,
	lifecycleToken: WorkspaceLifecycleToken,
	announceCreation = false,
): Promise<CreateSessionResult> {
	const sessionId = options.sessionManager.getSessionId();
	if (sessionIsTearingDown(sessionId))
		return Promise.reject(new Error(`Unknown session: ${sessionId}`));
	return trackSessionPreparation(workspaceId, lifecycleToken, () =>
		createParentSessionInternal(options, workspaceId, generation, lifecycleToken, announceCreation),
	);
}

async function createParentSessionInternal(
	options: ParentSessionOptions,
	workspaceId: string,
	generation: PiRuntimeGeneration,
	lifecycleToken: WorkspaceLifecycleToken,
	announceCreation = false,
): Promise<CreateSessionResult> {
	const { sessionManager, cwd } = options;
	const sessionId = sessionManager.getSessionId();
	const toolResponseWaiters = createToolResponseWaiters();
	let engine: AgentSession | undefined;
	let settings: HostSessionSettings | undefined;
	const mcpHost = createMcpSessionHost({
		cwd,
		policy: () => mcpPolicyResolver(workspaceId),
		projectTrusted: () => settings?.projectTrusted === true,
		onCommandSettled: scheduleMcpStatusRefresh,
		askForToolCall: (toolCallId, input, title, choices, signal) =>
			selectForToolCall(
				sessionId,
				{ toolCallId, toolInput: input },
				title,
				choices,
				signal ? { signal } : undefined,
			),
		grantTool: (server, target, tool) => {
			try {
				mcpToolGrantWriter(workspaceId, server, target, tool);
			} catch (error) {
				log.warn(`could not save the MCP grant for ${tool}`, error as Error);
			}
		},
	});
	const canDeliverCompletion = () =>
		canUseSessionResources(sessionId, workspaceId) &&
		!toolResponseWaiters.awaitsResponse() &&
		!sessions.get(sessionId)?.reloadRunning &&
		!sessions.get(sessionId)?.manualCompactionInProgress &&
		!sessions.get(sessionId)?.piCompactionInProgress;
	const subagents = subagentsFor(
		workspaceId,
		() => subagentsEnabled(workspaceId),
		() => sessions.get(sessionId)?.subagents === subagents && canDeliverCompletion(),
	);
	const commands = createBackgroundCommands({
		sessionId,
		getContext: () => {
			const session = sessions.get(sessionId)?.session ?? engine;
			if (!session || !settings || hasDeletionTombstone(sessionId))
				throw new Error("Session resources unavailable");
			const hostSettings = sessions.get(sessionId)?.settings ?? settings;
			return {
				cwd: session.sessionManager.getCwd(),
				sessionFile: session.sessionManager.getSessionFile(),
				model: session.model,
				thinkingLevel: session.thinkingLevel ?? "off",
				commandPrefix: cfgLegacyShellCommandPrefix.get(hostSettings.settings),
			};
		},
		canDeliverCompletion: () =>
			sessions.get(sessionId)?.commands === commands && canDeliverCompletion(),
	});
	const endRun = () =>
		(sessions.get(sessionId)?.session ?? engine)?.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
	const build: SessionBuilder = async (manager, hostSettings, model) => {
		const loadedRegistry = new Set<string>();
		settings = hostSettings;
		const resources = await buildSessionResources({
			cwd,
			settings: hostSettings.settings,
			projectTrusted: hostSettings.projectTrusted,
			getAdmission: () => skillAdmissionResolver(workspaceId),
			excludedExtensionPaths: generation.excludedSessionExtensionPaths,
			extraFactories: [
				subagents.extension,
				createBackgroundCommandsExtension({ service: commands }),
				...mcpHost.extensions,
			],
			session: toolResponseSessionServices(toolResponseWaiters, endRun),
			onRegistryLoaded: (name) => loadedRegistry.add(name),
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir: getAgentDir(),
			settings: hostSettings.settings,
			authStorage: generation.runtime.authStorage,
			modelRegistry: generation.runtime.modelRegistry,
			sessionManager: manager,
			agentId: manager.getSessionId(),
			...(model ? { model } : {}),
			...resources,
			...mcpHost.sessionOptions(),
			hasUI: true,
		});
		engine = session;
		return { session, loadedRegistry };
	};
	const parts: EngineSessionParts = {
		workspaceId,
		generation,
		commands,
		subagents,
		toolResponseWaiters,
		mcpHost,
	};
	let entry: Entry | undefined;
	try {
		const hostSettings = await loadHostSettings(cwd, piResourceTrustFor(workspaceId));
		const built = await build(sessionManager, hostSettings, options.model);
		if (options.thinkingLevel && built.session.model) {
			built.session.setThinkingLevel(
				engineThinkingLevel(built.session.model, options.thinkingLevel),
			);
		}
		entry = newEntry(parts, built, hostSettings, build);
		return await registerSession(entry, lifecycleToken, announceCreation);
	} catch (error) {
		if (entry && sessions.get(sessionId) === entry) {
			try {
				await disposeSession(sessionId);
			} catch {}
		} else if (entry) {
			if (!entry.disposed) abandonPreparedEntry(entry);
		} else {
			subagents.dispose();
			const shutdown = mcpHost
				.shutdownEngine()
				.catch(() => {})
				.then(() => engine?.dispose());
			void trackCascade(
				workspaceId,
				Promise.allSettled([commands.dispose(), shutdown]).then(() => {}),
			);
			toolResponseWaiters.abandon();
		}
		throw error;
	}
}

export function canUseSessionResources(sessionId: string, workspaceId: string): boolean {
	const entry = sessions.get(sessionId);
	return (
		!!entry &&
		entry.registered &&
		!entry.resourcesClosing &&
		entry.workspaceId === workspaceId &&
		sessionCanAttach(sessionId, workspaceId) &&
		!hasDeletionTombstone(sessionId)
	);
}

export async function withSessionResources<T>(
	workspaceId: string,
	sessionId: string,
	cwd: string,
	operation: (commands: BackgroundCommands) => T | Promise<T>,
): Promise<T> {
	if (sessionIsTearingDown(sessionId))
		throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
	if (!sessions.has(sessionId) && !hasDeletionTombstone(sessionId)) {
		try {
			await ensureSessionAttached(sessionId, workspaceId, cwd);
		} catch {
			throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
		}
	}
	const entry = sessions.get(sessionId);
	if (
		!entry ||
		!canUseSessionResources(sessionId, workspaceId) ||
		entry.session.sessionManager.getCwd() !== cwd
	)
		throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
	return operation(entry.commands);
}

function summaryOf(sessionId: string, entry: Entry): SessionSummary {
	const { session } = entry;
	return {
		sessionId,
		workspaceId: entry.workspaceId,
		title: session.sessionName ?? "",
		...entryFirstPrompt(entry),
		model: session.model ? sessionWireModel(session.model, entry.generation) : null,
		thinkingLevel: wireThinkingLevel(session.thinkingLevel),
		isStreaming: session.isStreaming,
		messageCount: session.messages.length,
		updatedAt: Date.now(),
		live: true,
		state: stateFromEntry(entry),
		...(entry.lastSettlement !== undefined ? { lastSettlement: entry.lastSettlement } : {}),
		...(effectivePendingCount(entry) > 0 ? { queue: queueStateOf(entry) } : {}),
	};
}

interface SessionFileIdentity {
	id: string;
	cwd: string;
}

type ScannedSessionFile =
	| { path: string; ok: true; identity: SessionFileIdentity }
	| { path: string; ok: false; error: Error };

function defaultSessionDirectory(cwd: string): string {
	return SessionManager.getDefaultSessionDir(cwd);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

async function readSessionFileIdentity(path: string): Promise<SessionFileIdentity | null> {
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof entry !== "object" || entry === null) {
				throw new Error("first parsed entry is not an object");
			}
			const id = Reflect.get(entry, "id");
			if (Reflect.get(entry, "type") !== "session" || typeof id !== "string") {
				return null;
			}
			const headerCwd = Reflect.get(entry, "cwd");
			return { id, cwd: typeof headerCwd === "string" ? headerCwd : "" };
		}
		throw new Error("session header is missing");
	} catch (error) {
		throw new Error(`Session transcript is unreadable or malformed: ${path}`, { cause: error });
	} finally {
		lines.close();
		input.destroy();
	}
}

async function scanSessionFiles(
	cwd: string,
	excludedPaths: ReadonlySet<string> = new Set(),
): Promise<ScannedSessionFile[]> {
	const dir = defaultSessionDirectory(cwd);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw new Error(`Session directory is unreadable: ${dir}`, { cause: error });
	}
	const scanned: ScannedSessionFile[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		if (excludedPaths.has(resolve(path))) continue;
		try {
			const identity = await readSessionFileIdentity(path);
			if (identity) scanned.push({ path, ok: true, identity });
		} catch (error) {
			scanned.push({
				path,
				ok: false,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
	return scanned;
}

async function listSessionInfosStrict(
	cwd: string,
	excludedPaths: ReadonlySet<string> = new Set(),
): Promise<SessionInfo[]> {
	const scanned = await scanSessionFiles(cwd, excludedPaths);
	const broken = scanned.find((file) => !file.ok);
	if (broken && !broken.ok) throw broken.error;
	const infos = await SessionManager.list(cwd);
	const listedByPath = new Map(infos.map((info) => [resolve(info.path), info]));
	const omitted = scanned.find((file) => {
		if (!file.ok) return false;
		const listed = listedByPath.get(resolve(file.path));
		return !listed || listed.id !== file.identity.id || listed.cwd !== file.identity.cwd;
	});
	if (omitted) throw new Error(`Session transcript could not be listed: ${omitted.path}`);
	return infos;
}

async function listSessionsInternal(workspaceId: string, cwd: string): Promise<SessionSummary[]> {
	const live: SessionSummary[] = [];
	const liveIds = new Set<string>();
	const liveFiles = new Set<string>();
	for (const [sessionId, entry] of sessions) {
		if (entry.workspaceId !== workspaceId || isSessionDeleted(sessionId, workspaceId)) continue;
		const sessionFile = entry.session.sessionManager.getSessionFile();
		if (sessionFile) liveFiles.add(resolve(sessionFile));
		live.push(summaryOf(sessionId, entry));
		liveIds.add(sessionId);
	}
	const infos = await listSessionInfosStrict(cwd, liveFiles);
	const disk = infos
		.filter(
			(info) =>
				info.cwd === cwd && !liveIds.has(info.id) && !isSessionDeleted(info.id, workspaceId),
		)
		.map(async (info): Promise<SessionSummary> => {
			const manager = await openTranscript(info.path);
			try {
				return {
					sessionId: info.id,
					workspaceId,
					title: manager.getSessionName() ?? info.title ?? "",
					...firstPromptOf(manager.getEntries()),
					model: null,
					thinkingLevel: "medium",
					isStreaming: false,
					messageCount: info.messageCount,
					updatedAt: info.modified.getTime(),
					live: false,
					state: stateFromDisk(info.id, manager),
				};
			} finally {
				await manager.close();
			}
		});
	return [...live, ...(await Promise.all(disk))];
}

export function listSessions(workspaceId: string, cwd: string): Promise<SessionSummary[]> {
	return listSessionsInternal(workspaceId, cwd);
}

export interface SessionStateWorkspace {
	id: string;
	projectId: string;
	cwd: string;
}

async function listBaselineSessionInfos(cwd: string): Promise<SessionInfo[]> {
	try {
		return await listSessionInfosStrict(cwd);
	} catch (error) {
		log.warn(`session baseline is skipping unreadable transcripts for ${cwd}`, error);
		return SessionManager.list(cwd);
	}
}

interface CollectedSessionState {
	record: SessionStateRecord;
	branch: () => readonly SessionEntry[];
	publish: () => SessionStateRecord;
}

async function collectSessionStates(
	workspaces: readonly SessionStateWorkspace[],
	baseline: boolean,
): Promise<SessionStateRecord[]> {
	return (await collectSessionStateSources(workspaces, baseline)).map(({ record }) => record);
}

async function collectSessionStateSources(
	workspaces: readonly SessionStateWorkspace[],
	baseline: boolean,
): Promise<CollectedSessionState[]> {
	const discovered: { workspace: SessionStateWorkspace; infos: SessionInfo[] }[] = [];
	for (const workspace of workspaces) {
		discovered.push({
			workspace,
			infos: baseline
				? await listBaselineSessionInfos(workspace.cwd)
				: await listSessionInfosStrict(workspace.cwd),
		});
	}
	const records: CollectedSessionState[] = [];
	for (const [sessionId, entry] of sessions) {
		if (isSessionDeleted(sessionId, entry.workspaceId)) continue;
		const workspace = workspaces.find((candidate) => candidate.id === entry.workspaceId);
		if (!workspace) continue;
		records.push({
			record: {
				sessionId,
				workspaceId: entry.workspaceId,
				projectId: workspace.projectId,
				state: stateFromEntry(entry),
				...entryFirstPrompt(entry),
			},
			branch: () => entry.session.sessionManager.getBranch(),
			publish: () => {
				publishEntryState(entry);
				return stateRecordForEntry(entry);
			},
		});
	}
	for (const { workspace, infos } of discovered) {
		for (const info of infos) {
			if (
				info.cwd !== workspace.cwd ||
				sessions.has(info.id) ||
				isSessionDeleted(info.id, workspace.id)
			) {
				continue;
			}
			const manager = await openTranscript(info.path);
			const record: SessionStateRecord = {
				sessionId: info.id,
				workspaceId: workspace.id,
				projectId: workspace.projectId,
				state: stateFromDisk(info.id, manager, baseline),
				...firstPromptOf(manager.getEntries()),
			};
			records.push({
				record,
				branch: () => manager.getBranch(),
				publish: () => {
					const current = { ...record, state: stateFromDisk(info.id, manager) };
					publishState(current);
					return current;
				},
			});
		}
	}
	return records;
}

function lastActivityAt(source: CollectedSessionState): number {
	const last = source.branch().at(-1);
	return last ? Date.parse(last.timestamp) || 0 : 0;
}

function initializedReceipts(): SessionReceipts {
	const current = receipts();
	if (!current?.baselineComplete) throw new Error("Session state is not initialized");
	return current;
}

export async function markWorkspaceUnread(
	workspace: SessionStateWorkspace,
): Promise<SessionStateRecord | null> {
	initializedReceipts();
	const sources = await collectSessionStateSources([workspace], false);
	const ranked = sources
		.map((source) => ({ source, at: lastActivityAt(source) }))
		.sort((a, b) => b.at - a.at);
	for (const { source } of ranked) {
		if (!canMarkCompletionUnread(source.record.state)) continue;
		const currentReceipts = initializedReceipts();
		const nextReceipts: SessionReceipts = {
			...currentReceipts,
			handledCompletionBySession: omitMetadataKey(
				currentReceipts.handledCompletionBySession,
				source.record.sessionId,
			),
		};
		saveSessionReceipts(nextReceipts);
		sessionReceipts = nextReceipts;
		return source.publish();
	}
	return null;
}

export async function markWorkspaceRead(
	workspace: SessionStateWorkspace,
): Promise<SessionStateRecord[]> {
	initializedReceipts();
	const sources = await collectSessionStateSources([workspace], false);
	const unread = sources.flatMap((source) => {
		const { state } = source.record;
		return state.completionUnread && state.completion
			? [{ source, completionId: state.completion.completionId }]
			: [];
	});
	if (unread.length === 0) return [];
	const currentReceipts = initializedReceipts();
	const handledCompletionBySession = { ...currentReceipts.handledCompletionBySession };
	for (const { source, completionId } of unread) {
		handledCompletionBySession[source.record.sessionId] = completionId;
	}
	const nextReceipts: SessionReceipts = { ...currentReceipts, handledCompletionBySession };
	saveSessionReceipts(nextReceipts);
	sessionReceipts = nextReceipts;
	return unread.map(({ source }) => source.publish());
}

export async function initializeSessionStates(
	workspaces: readonly SessionStateWorkspace[],
): Promise<void> {
	ensureSessionMetadata();
	const currentReceipts = receipts();
	if (currentReceipts?.baselineComplete) return;
	const records = await collectSessionStates(workspaces, true);
	const currentLifecycle = lifecycle();
	const completionBySession = { ...currentLifecycle.completionBySession };
	const handledCompletionBySession = {
		...(currentReceipts?.handledCompletionBySession ?? {}),
	};
	for (const record of records) {
		const { completion, runId } = record.state;
		if (!completion || !runId) continue;
		completionBySession[record.sessionId] = { runId, completion };
		if (completion.outcome !== "cancelled") {
			handledCompletionBySession[record.sessionId] = completion.completionId;
		}
	}
	const nextLifecycle: SessionLifecycle = { ...currentLifecycle, completionBySession };
	const nextReceipts: SessionReceipts = {
		version: 1,
		baselineComplete: true,
		handledCompletionBySession,
	};
	saveSessionLifecycle(nextLifecycle);
	saveSessionReceipts(nextReceipts);
	sessionLifecycle = nextLifecycle;
	sessionReceipts = nextReceipts;
}

export async function listSessionStates(
	workspaces: readonly SessionStateWorkspace[],
): Promise<SessionStateRecord[]> {
	if (!receipts()?.baselineComplete) throw new Error("Session state is not initialized");
	return collectSessionStates(workspaces, false);
}

const sessionFileOperations = new Map<string, Promise<void>>();

function serializeSessionFileOperation<T>(
	sessionId: string,
	operation: () => Promise<T> | T,
): Promise<T> {
	const previous = sessionFileOperations.get(sessionId) ?? Promise.resolve();
	const result = previous.catch(() => {}).then(operation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	sessionFileOperations.set(sessionId, settled);
	return result.finally(() => {
		if (sessionFileOperations.get(sessionId) === settled) sessionFileOperations.delete(sessionId);
	});
}

export interface RenameSessionOptions {
	onlyIfUnnamed?: boolean;
}

export function renameSession(
	sessionId: string,
	workspaceId: string,
	cwd: string,
	title: string,
	options: RenameSessionOptions = {},
): Promise<boolean> {
	const normalized = normalizeSessionTitle(title);
	if (!normalized) return Promise.reject(new Error("Invalid session title"));
	return serializeSessionFileOperation(sessionId, async () => {
		if (hasDeletionTombstone(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
		const live = sessions.get(sessionId);
		if (live) {
			if (live.workspaceId !== workspaceId) throw new Error(`Unknown session: ${sessionId}`);
			const current = live.session.sessionName;
			if ((options.onlyIfUnnamed && current !== undefined) || current === normalized) return false;
			await live.session.setSessionName(normalized, "user");
			return true;
		}

		const info = (await listSessionInfosStrict(cwd)).find(
			(candidate) => candidate.id === sessionId && candidate.cwd === cwd,
		);
		if (!info || hasDeletionTombstone(sessionId)) {
			throw new Error(`Unknown session: ${sessionId}`);
		}
		const manager = await openTranscript(info.path);
		try {
			const current = manager.getSessionName();
			if ((options.onlyIfUnnamed && current !== undefined) || current === normalized) return false;
			await manager.setSessionName(normalized, "user");
		} finally {
			await manager.close();
		}
		publish({ sessionId, event: { type: "session_info_changed", name: normalized } });
		return true;
	});
}

const attaching = new Map<string, Promise<void>>();

function attachDiskSession(
	sessionId: string,
	workspaceId: string,
	cwd: string,
	lifecycleToken: WorkspaceLifecycleToken,
): Promise<void> {
	if (
		!workspaceAcceptsSessions(workspaceId, lifecycleToken) ||
		!sessionCanAttach(sessionId, workspaceId)
	)
		return Promise.reject(new Error(`Unknown session: ${sessionId}`));
	if (sessions.has(sessionId)) return Promise.resolve();
	let pending = attaching.get(sessionId);
	if (!pending) {
		pending = serializeSessionFileOperation(sessionId, () =>
			openDiskSession(sessionId, workspaceId, cwd, lifecycleToken),
		).finally(() => attaching.delete(sessionId));
		attaching.set(sessionId, pending);
	}
	return pending;
}

function persistedSessionModelRef(
	model: string | undefined,
): { provider: string; id: string } | undefined {
	if (model === undefined) return undefined;
	const at = model.indexOf("/");
	const id = model.slice(at + 1);
	if (at <= 0 || !id) throw new Error("The chat's saved model is unavailable.");
	return { provider: model.slice(0, at), id };
}

async function openTranscript(path: string): Promise<SessionManager> {
	try {
		await upgradePiSessionFile(path);
	} catch (error) {
		log.error(`chat transcript ${path} was saved by pi and could not be converted`, error);
		throw error instanceof PiSessionFormatError
			? error
			: new PiSessionFormatError(
					`Chat transcript ${path} could not be converted from pi's format`,
					{
						cause: error,
					},
				);
	}
	return SessionManager.open(path, undefined, undefined, { throwIfMissing: true });
}

async function openDiskSession(
	sessionId: string,
	workspaceId: string,
	cwd: string,
	lifecycleToken: WorkspaceLifecycleToken,
): Promise<void> {
	if (
		!workspaceAcceptsSessions(workspaceId, lifecycleToken) ||
		!sessionCanAttach(sessionId, workspaceId)
	)
		throw new Error(`Unknown session: ${sessionId}`);
	const info = (await listSessionInfosStrict(cwd)).find(
		(candidate) => candidate.id === sessionId && candidate.cwd === cwd,
	);
	if (!info) throw new Error(`Unknown session: ${sessionId}`);
	if (sessions.has(sessionId)) return;
	const generation = await getPiRuntimeGeneration();
	const sessionManager = await openTranscript(info.path);
	const persistedModel = persistedSessionModelRef(
		sessionManager.buildSessionContext().models.default,
	);
	let exactModel: CatalogModel | undefined;
	if (persistedModel) {
		try {
			exactModel = resolvePersistedModel(generation.runtime, persistedModel);
		} catch {
			const pi = generation.runtime.getAvailableSnapshot();
			if (pi.some((model) => sameModel(model, persistedModel)))
				exactModel = preferredDefaultModel(settledAvailableModels(generation.runtime), (provider) =>
					generation.runtime.modelRegistry.hasConcreteAuth(provider),
				);
		}
	}
	repairDanglingToolCalls(sessionManager, enabledInteractiveTools());
	await createParentSession(
		{
			cwd,
			sessionManager,
			...(exactModel ? { model: exactModel } : {}),
		},
		workspaceId,
		generation,
		lifecycleToken,
	);
}

async function ensureSessionAttachedInternal(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<boolean> {
	await sessionTeardowns.get(sessionId);
	const lifecycleToken = captureWorkspaceLifecycle(workspaceId);
	if (
		!workspaceAcceptsSessions(workspaceId, lifecycleToken) ||
		!sessionCanAttach(sessionId, workspaceId)
	)
		return false;
	const live = sessions.get(sessionId);
	if (live) {
		if (live.workspaceId !== workspaceId) throw new Error(`Unknown session: ${sessionId}`);
		return true;
	}
	const known = (await listSessionInfosStrict(cwd)).some(
		(candidate) => candidate.id === sessionId && candidate.cwd === cwd,
	);
	if (!known || !workspaceAcceptsSessions(workspaceId, lifecycleToken)) return false;
	await attachDiskSession(sessionId, workspaceId, cwd, lifecycleToken);
	if (!sessions.has(sessionId))
		throw new Error(`Session ${sessionId} was re-opened but did not register.`);
	return true;
}

export function ensureSessionAttached(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<boolean> {
	return ensureSessionAttachedInternal(sessionId, workspaceId, cwd);
}

async function getSessionMessagesInternal(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<{ summary: SessionSummary; messages: TranscriptMessage[] }> {
	await sessionTeardowns.get(sessionId);
	const lifecycleToken = captureWorkspaceLifecycle(workspaceId);
	if (
		!workspaceAcceptsSessions(workspaceId, lifecycleToken) ||
		!sessionCanAttach(sessionId, workspaceId)
	)
		throw new Error(`Unknown session: ${sessionId}`);
	let entry = sessions.get(sessionId);
	if (entry && entry.workspaceId !== workspaceId) throw new Error(`Unknown session: ${sessionId}`);
	if (!entry) {
		await attachDiskSession(sessionId, workspaceId, cwd, lifecycleToken);
		if (!sessionCanAttach(sessionId, workspaceId)) throw new Error(`Unknown session: ${sessionId}`);
		entry = sessions.get(sessionId);
		if (!entry) throw new Error(`Unknown session: ${sessionId}`);
	}
	const messages =
		entry.shutdown?.session === entry.session
			? await shutDownTranscript(entry.session)
			: transcriptMessages(entry.session);
	return { summary: summaryOf(sessionId, entry), messages };
}

async function shutDownTranscript(session: AgentSession): Promise<TranscriptMessage[]> {
	const file = session.sessionManager.getSessionFile();
	if (!file || !existsSync(file)) return [];
	const manager = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
	try {
		return wireTranscriptMessages(
			manager.buildSessionContext({ transcript: true, collapseCompactedHistory: true }).messages,
		);
	} finally {
		await manager.close();
	}
}

export function getSessionMessages(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<{ summary: SessionSummary; messages: TranscriptMessage[] }> {
	return getSessionMessagesInternal(sessionId, workspaceId, cwd);
}

export async function respondToTool(
	sessionId: string,
	toolCallId: string,
	response: unknown,
): Promise<void> {
	const entry = mustGetEntry(sessionId);
	const live = entry.toolResponseWaiters.respond(toolCallId, response);
	if (live.handled) {
		publishEntryState(entry);
		await live.persisted;
		return;
	}
	const interactive = enabledInteractiveTools();
	const verdict = assessRespondability(entry.session.messages, toolCallId, interactive);
	if (!verdict.ok) throw new Error(`${RESPONDABILITY_ERRORS[verdict.reason]}: ${toolCallId}`);
	if (!hasPendingToolResult(entry.session.messages, toolCallId)) {
		throw new Error(`${RESPONDABILITY_ERRORS.not_awaiting}: ${toolCallId}`);
	}
	const content = describeToolResponse(verdict.toolName, verdict.args, response, interactive);
	const release = admitPreflight(entry);
	try {
		await entry.session.sendCustomMessage(buildToolResponseMessage(content, toolCallId, response), {
			triggerTurn: true,
		});
	} finally {
		release();
	}
}

function pendingPrompts(entry: Entry, kind: QueueLane, includeLiveSteered = true): AgentMessage[] {
	const { agent } = entry.session;
	const queue =
		kind === "steering"
			? [
					...(includeLiveSteered ? agent.peekLiveSteeredMessages() : []),
					...agent.peekSteeringQueue(),
				]
			: agent.peekFollowUpQueue();
	return queue.filter(isUserAuthoredQueuedMessage);
}

function queuedPromptOf(entry: Entry, message: AgentMessage): QueuedPrompt {
	const recorded = entry.queuedPrompts.get(message);
	if (recorded) return recorded;
	const content = "content" in message ? message.content : undefined;
	const images = userContentImages(content);
	return {
		text: userContentText(content),
		...(images.length > 0 ? { images } : {}),
		group: [message],
	};
}

function displayedLane(entry: Entry, kind: QueueLane): string[] {
	return pendingPrompts(entry, kind).map((message) => queuedPromptOf(entry, message).text);
}

function queueUpdateEventOf(entry: Entry): PiEvent {
	return {
		type: "queue_update",
		steering: displayedLane(entry, "steering"),
		followUp: displayedLane(entry, "followUp"),
		...(hasQueuedImages(entry) ? { hasImages: true as const } : {}),
	};
}

type UserContentBlock = { type: string; text?: string } | ImageContent;

function userContentBlocks(content: unknown): UserContentBlock[] {
	return Array.isArray(content) ? (content as UserContentBlock[]) : [];
}

function userContentText(content: unknown): string {
	if (typeof content === "string") return content;
	return userContentBlocks(content)
		.flatMap((block) => (block.type === "text" && "text" in block ? [block.text ?? ""] : []))
		.join("");
}

function userContentImages(content: unknown): ImageContent[] {
	return userContentBlocks(content).filter(
		(block): block is ImageContent => block.type === "image",
	);
}

function hasQueuedImages(entry: Entry, includeLiveSteered = true): boolean {
	return (["steering", "followUp"] as const).some((kind) =>
		pendingPrompts(entry, kind, includeLiveSteered).some(
			(message) => (queuedPromptOf(entry, message).images?.length ?? 0) > 0,
		),
	);
}

function queueContentOf(entry: Entry, includeLiveSteered = true): SessionQueueContent {
	const project = (message: AgentMessage): QueuedMessageContent => {
		const { text, images } = queuedPromptOf(entry, message);
		return { text, ...(images && images.length > 0 ? { images: [...images] } : {}) };
	};
	return {
		steering: pendingPrompts(entry, "steering", includeLiveSteered).map(project),
		followUp: pendingPrompts(entry, "followUp", includeLiveSteered).map(project),
	};
}

function mergeQueueContent(
	before: SessionQueueContent,
	after: SessionQueueContent,
): SessionQueueContent {
	return {
		steering: [...before.steering, ...after.steering],
		followUp: [...before.followUp, ...after.followUp],
	};
}

type QueuedDisposition = "queued" | "handled";

async function queuePrompt(
	entry: Entry,
	text: string,
	images: ImageContent[] | undefined,
	send: (onPromptQueued: (queued: readonly AgentMessage[]) => void) => Promise<void>,
): Promise<QueuedDisposition> {
	let queued = false;
	await send((group) => {
		queued = true;
		const prompt: QueuedPrompt = {
			text,
			...(images && images.length > 0 ? { images: [...images] } : {}),
			group,
		};
		for (const message of group)
			if (isUserAuthoredQueuedMessage(message)) entry.queuedPrompts.set(message, prompt);
	});
	return queued ? "queued" : "handled";
}

async function steerEntry(
	entry: Entry,
	text: string,
	images: ImageContent[] | undefined,
): Promise<void> {
	const disposition = await queuePrompt(entry, text, images, (onPromptQueued) =>
		entry.session.steer(text, images, { onPromptQueued }),
	);
	if (disposition !== "queued") return;
	cancelExtUiForSession(entry.session.sessionId);
	if (entry.toolResponseWaiters.supersede()) publishEntryState(entry);
}

export async function promptSession(
	sessionId: string,
	text: string,
	images?: ImageContent[],
): Promise<void> {
	const entry = mustGetEntry(sessionId);
	admitRun(entry);
	const release = entry.session.isStreaming ? () => {} : admitPreflight(entry);
	try {
		const input = await applyInputHandlers(entry, text, images);
		if (!input) return;
		if (entry.session.isStreaming) {
			const runWasLive = entry.runActive;
			await steerEntry(entry, input.text, input.images);
			if (!runWasLive) await deliverStrandedQueue(entry);
			return;
		}
		await entry.toolPolicy;
		await entry.session.prompt(input.text, answeringDialogs(entry, input.text, input.images));
	} finally {
		release();
	}
	await untilSettled(entry);
}

interface UserInput {
	text: string;
	images: ImageContent[] | undefined;
}

async function applyInputHandlers(
	entry: Entry,
	text: string,
	images: ImageContent[] | undefined,
): Promise<UserInput | null> {
	const runner = entry.session.extensionRunner;
	if (!runner?.hasHandlers("input") || isExtensionCommand(entry.session, text))
		return { text, images };
	const result = await runner.emitInput(text, images, "rpc");
	if (result.handled) return null;
	return { text: result.text ?? text, images: result.images ?? images };
}

function isExtensionCommand(session: AgentSession, text: string): boolean {
	if (!text.startsWith("/")) return false;
	const space = text.indexOf(" ");
	const name = space === -1 ? text.slice(1) : text.slice(1, space);
	return session.extensionRunner?.getCommand(name) !== undefined;
}

function answeringDialogs(
	entry: Entry,
	text: string,
	images: ImageContent[] | undefined,
): PromptOptions {
	return {
		...(images ? { images } : {}),
		onPromptAdmitted: () => {
			if (!isExtensionCommand(entry.session, text)) cancelExtUiForSession(entry.session.sessionId);
		},
	};
}

export async function steerSession(
	sessionId: string,
	text: string,
	images?: ImageContent[],
): Promise<void> {
	const entry = mustGetEntry(sessionId);
	admitRun(entry);
	const input = await applyInputHandlers(entry, text, images);
	if (input) await steerEntry(entry, input.text, input.images);
}

export async function followUpSession(
	sessionId: string,
	text: string,
	images?: ImageContent[],
): Promise<void> {
	const entry = mustGetEntry(sessionId);
	admitRun(entry);
	const input = await applyInputHandlers(entry, text, images);
	if (input) await followUpEntry(entry, input.text, input.images, true);
}

async function followUpEntry(
	entry: Entry,
	text: string,
	images: ImageContent[] | undefined,
	answersDialogs: boolean,
): Promise<void> {
	admitRun(entry);
	if (entry.session.isStreaming) {
		const runWasLive = entry.runActive;
		const disposition = await queuePrompt(entry, text, images, (onPromptQueued) =>
			entry.session.followUp(text, images, { onPromptQueued }),
		);
		if (answersDialogs && disposition === "queued") cancelExtUiForSession(entry.session.sessionId);
		if (answersDialogs && !runWasLive) await deliverStrandedQueue(entry);
		return;
	}
	const release = admitPreflight(entry);
	try {
		await entry.toolPolicy;
		await entry.session.prompt(
			text,
			answersDialogs ? answeringDialogs(entry, text, images) : images ? { images } : undefined,
		);
	} finally {
		release();
	}
	await untilSettled(entry);
}

// Callers MUST `ackSend`-wrap this: a pre-turn rejection has to roll the review record back — see submodule-server-todos.
export async function sendReviewFixToSession(
	sessionId: string,
	content: string,
	details: ReviewFixDetails,
): Promise<void> {
	const entry = mustGetEntry(sessionId);
	const release = admitPreflight(entry);
	try {
		await entry.session.sendCustomMessage(
			{ customType: TODO_REVIEW_FIX_CUSTOM_TYPE, content, display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} finally {
		release();
	}
}

export async function compactSession(sessionId: string, instructions?: string): Promise<void> {
	const entry = mustGetEntry(sessionId);
	admitRun(entry);
	if (entry.manualCompactionInProgress || entry.piCompactionInProgress) {
		throw new Error("Compaction is already in progress for this session");
	}
	entry.manualCompactionInProgress = true;
	entry.emit({ type: "compaction_start", reason: "manual" });
	let result: Awaited<ReturnType<AgentSession["compact"]>> | undefined;
	let failure: unknown;
	try {
		result = await entry.session.compact(instructions);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		entry.manualCompactionInProgress = false;
		entry.emit({
			type: "compaction_end",
			reason: "manual",
			result,
			aborted: entry.session.isAborting,
			willRetry: false,
			...(failure === undefined
				? {}
				: { errorMessage: failure instanceof Error ? failure.message : String(failure) }),
		});
		reconsiderPendingReload(entry);
	}
}

function queueStateOf(entry: Entry): SessionQueueState {
	return {
		steering: displayedLane(entry, "steering"),
		followUp: displayedLane(entry, "followUp"),
		...(hasQueuedImages(entry) ? { hasImages: true as const } : {}),
	};
}

export function clearQueueSession(sessionId: string, requireTextOnly = false): SessionQueueContent {
	return clearEntryQueue(mustGetEntry(sessionId), { requireTextOnly });
}

function clearEntryQueue(
	entry: Entry,
	options: { requireTextOnly?: boolean; forInterrupt?: boolean } = {},
): SessionQueueContent {
	const forInterrupt = options.forInterrupt === true;
	const content = queueContentOf(entry, forInterrupt);
	if (options.requireTextOnly && hasQueuedImages(entry, forInterrupt)) {
		throw new Error("Cannot restore queued image messages as text");
	}
	entry.session.clearQueue(forInterrupt ? { forInterrupt } : undefined);
	return content;
}

export async function removeQueuedSession(
	sessionId: string,
	kind: QueueLane,
	index: number,
): Promise<RemovedQueuedMessage> {
	const entry = mustGetEntry(sessionId);
	const release = admitPreflight(entry, true);
	try {
		const { session } = entry;
		const target = pendingPrompts(entry, kind)[index];
		let removed: QueuedMessageContent | null = null;
		if (target && !session.agent.peekLiveSteeredMessages().includes(target)) {
			const prompt = queuedPromptOf(entry, target);
			session.dropQueuedMessages(prompt.group);
			removed = {
				text: prompt.text,
				...(prompt.images && prompt.images.length > 0 ? { images: [...prompt.images] } : {}),
			};
		}
		await deliverStrandedQueue(entry);
		return { removed, queue: queueStateOf(entry) };
	} finally {
		release();
	}
}

const QUEUE_DRAIN_RESOLVE_MS = 2_000;

async function untilQueueDrainResolved(entry: Entry): Promise<void> {
	const { session } = entry;
	const until = Date.now() + QUEUE_DRAIN_RESOLVE_MS;
	while (session.isStreaming && !entry.runActive && !entry.disposed && Date.now() < until)
		await Bun.sleep(5);
}

async function deliverStrandedQueue(entry: Entry): Promise<void> {
	await untilQueueDrainResolved(entry);
	const { session } = entry;
	if (entry.disposed || session.isStreaming || session.queuedMessageCount === 0) return;
	const parked = clearEntryQueue(entry);
	for (const message of [...parked.steering, ...parked.followUp]) {
		await followUpEntry(
			entry,
			message.text,
			message.images ? [...message.images] : undefined,
			false,
		);
	}
}

const ACCEPTED_ANSWER_STOP_GRACE_MS = 1_000;

async function waitForAcceptedAnswerGrace(
	acceptedResult: Promise<void> | null,
	timeoutMs: number,
): Promise<void> {
	if (!acceptedResult) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, Math.max(0, timeoutMs));
		timer.unref?.();
	});
	await Promise.race([acceptedResult.catch(() => {}), timeout]);
	if (timer) clearTimeout(timer);
}

export async function abortSession(
	sessionId: string,
	restoreQueue = false,
	acceptedAnswerGraceMs = ACCEPTED_ANSWER_STOP_GRACE_MS,
): Promise<SessionQueueContent | undefined> {
	const entry = mustGetEntry(sessionId);
	if (entry.session.isStreaming) markCancelledRun(entry);
	return abortEntry(entry, restoreQueue, acceptedAnswerGraceMs);
}

async function abortEntry(
	entry: Entry,
	restoreQueue: boolean,
	acceptedAnswerGraceMs = ACCEPTED_ANSWER_STOP_GRACE_MS,
): Promise<SessionQueueContent | undefined> {
	let restoredQueue = restoreQueue ? clearEntryQueue(entry, { forInterrupt: true }) : undefined;
	const acceptedResult = entry.toolResponseWaiters.prepareAbort();
	await waitForAcceptedAnswerGrace(acceptedResult, acceptedAnswerGraceMs);
	if (sessions.get(entry.session.sessionId) !== entry) return restoredQueue;
	if (restoredQueue) {
		restoredQueue = mergeQueueContent(
			restoredQueue,
			clearEntryQueue(entry, { forInterrupt: true }),
		);
	}
	await entry.session.abort();
	return restoredQueue;
}

export async function setSessionModel(sessionId: string, model: WireModel): Promise<WireModel> {
	const entry = mustGetEntry(sessionId);
	const resolved = resolveWireModel(entry.generation.runtime, model);
	await entry.session.setModel(resolved);
	return sessionWireModel(resolved, entry.generation);
}

export function setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
	const session = mustGet(sessionId);
	if (!session.model) throw new Error("The chat has no model to set a thinking level for.");
	session.setThinkingLevel(engineThinkingLevel(session.model, level));
}

export function getSessionStats(sessionId: string): SessionStats {
	const session = mustGet(sessionId);
	const stats = session.getSessionStats();
	const { contextUsage } = stats;
	return {
		sessionId: stats.sessionId,
		totalMessages: stats.totalMessages,
		tokens: {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			total: stats.tokens.total,
		},
		cost: stats.cost,
		...(contextUsage ? { contextUsage } : {}),
	};
}

function reconcileSubagentUsageInBackground(workspaceId: string, sessionId: string): void {
	void reconcileSessionSubagentUsage(workspaceId, sessionId, () =>
		usageWritableEntry(sessionId)?.session.sessionManager.getEntries(),
	).catch((error: unknown) =>
		log.warn(`subagent usage was not reconciled for ${sessionId}`, error as Error),
	);
}

function usageWritableEntry(sessionId: string): Entry | undefined {
	if (hasDeletionTombstone(sessionId)) return undefined;
	return sessions.get(sessionId) ?? tearingDownEntries.get(sessionId);
}

export function recordSessionUsage(
	sessionId: string,
	record: { kind: string; provider: string; model: string; usage: Usage; note?: string },
): boolean {
	const entry = usageWritableEntry(sessionId);
	if (!entry) return false;
	const { sessionManager } = entry.session;
	const { kind, provider, model, usage, note } = record;
	const api = entry.generation.runtime.modelRegistry.find(provider, model)?.api ?? "unknown";
	try {
		const appended = sessionManager.appendModelUsage(
			{ purpose: usagePurpose(kind, note), api, provider, model, usage, stopReason: "stop" },
			{ sessionId: sessionManager.getSessionId(), parentId: sessionManager.getLeafId() },
		);
		if (appended === undefined || !sessionManager.getEntry(appended)) return false;
	} catch (error) {
		log.warn(`${kind} usage was not persisted for ${sessionId}`, error as Error);
		return false;
	}
	return true;
}

export interface McpSessionView {
	workspaceId: string;
	cwd: string;
	projectTrusted: boolean;
	policy: McpProjectPolicy;
	disabledInChat: ReadonlySet<string>;
	loaded: ReadonlyMap<string, HostMcpServerConfig> | null;
	runtime: readonly McpRuntimeStatus[];
	reconnect(name: string): Promise<void>;
	startup(): Promise<void>;
	artifact(id: string): Promise<{ path: string } | { text: string } | null>;
}

export function mcpSessionView(sessionId: string): McpSessionView | undefined {
	const entry = sessions.get(sessionId);
	if (
		!entry?.registered ||
		entry.disposed ||
		entry.resourcesClosing ||
		hasDeletionTombstone(sessionId)
	)
		return undefined;
	return {
		workspaceId: entry.workspaceId,
		cwd: entry.session.sessionManager.getCwd(),
		projectTrusted: entry.settings.projectTrusted,
		policy: mcpPolicyResolver(entry.workspaceId),
		disabledInChat: entry.mcpHost.disabledInChat,
		loaded: entry.mcpHost.loaded(),
		runtime: entry.mcpHost.registered(),
		reconnect: (name) => entry.mcpHost.reconnect(name),
		startup: () => entry.mcpHost.startup(),
		artifact: async (id) => {
			const manager = entry.session.sessionManager;
			const path = await manager.getArtifactPath(id);
			if (path) return { path };
			const text = manager.getArtifactContent(id);
			return text === null ? null : { text };
		},
	};
}

export function liveSessionIdsOf(workspaceId?: string): string[] {
	return [...sessions]
		.filter(
			([sessionId, entry]) =>
				(workspaceId === undefined || entry.workspaceId === workspaceId) &&
				mcpSessionView(sessionId),
		)
		.map(([sessionId]) => sessionId);
}

type McpCommandNotify = (message: string, level: "info" | "warning" | "error") => void;

function notifyingCommandContext(
	context: ExtensionCommandContext,
	notify: McpCommandNotify,
): ExtensionCommandContext {
	const ui = Object.getOwnPropertyDescriptor(context, "ui");
	const capture: ExtensionUIContext["notify"] = (message, type) => notify(message, type ?? "info");
	return Object.defineProperty(context, "ui", {
		get: (): ExtensionUIContext =>
			new Proxy<ExtensionUIContext>(ui?.get ? ui.get.call(context) : ui?.value, {
				get: (target, key) => (key === "notify" ? capture : Reflect.get(target, key)),
			}),
	});
}

export function dispatchSessionMcpCommand(
	sessionId: string,
	args: string,
	notify?: McpCommandNotify,
): Promise<void> | null {
	const entry = sessions.get(sessionId);
	const runner = entry?.session.extensionRunner;
	const command = runner?.getCommand("mcp");
	if (!entry || !runner || !command) return null;
	const context = runner.createCommandContext();
	return Promise.resolve(
		command.handler(args, notify ? notifyingCommandContext(context, notify) : context),
	);
}

export async function setSessionMcpServerEnabled(
	sessionId: string,
	name: string,
	enabled: boolean,
): Promise<SessionReloadDisposition | "unchanged"> {
	const entry = mustGetEntry(sessionId);
	const disabled = entry.mcpHost.disabledInChat;
	assertMcpServerDisablableInChat(sessionId, name);
	if (disabled.has(name) === !enabled && !hasFailedMcpReload(sessionId)) return "unchanged";
	if (enabled) disabled.delete(name);
	else disabled.add(name);
	const disposition = await requestSessionReload(sessionId);
	if (disposition === "deferred") showPendingMcpReload(sessionId);
	return disposition;
}

export function getSessionCommands(sessionId: string): SlashCommandInfo[] {
	const session = mustGet(sessionId);
	const extension = (session.extensionRunner?.getRegisteredCommands() ?? []).map((command) => ({
		name: command.name,
		source: "extension" as const,
		sourceInfo: {
			path: `extension:${command.name}`,
			source: "extension",
			scope: "user" as const,
			origin: "top-level" as const,
		},
		...(command.description !== undefined ? { description: command.description } : {}),
	}));
	const prompt = session.promptTemplates.map((template) => ({
		name: template.name,
		description: template.description,
		source: "prompt" as const,
		sourceInfo: promptTemplateSourceInfo(template),
	}));
	const skill = toSkillCommands(session.skills);
	return [...extension, ...prompt, ...skill];
}

export async function listAvailableModels(): Promise<WireModel[]> {
	const generation = await getPiRuntimeGeneration();
	void refreshCatalogs(generation.runtime);
	void refreshModelListings(generation.runtime, generation.opaqueProviderIds);
	return readAvailableWireModels(generation);
}

export async function listSettledModels(): Promise<{
	models: WireModel[];
	preferred: WireModel | undefined;
}> {
	const generation = await getPiRuntimeGeneration();
	const models = readAvailableWireModels(generation);
	const { runtime } = generation;
	const pick = preferredDefaultModel(settledAvailableModels(runtime), (provider) =>
		runtime.modelRegistry.hasConcreteAuth(provider),
	);
	return { models, preferred: pick && models.find((model) => sameModel(model, pick)) };
}

export async function refreshAvailableModels(force = false): Promise<RefreshedModels> {
	const generation = await getPiRuntimeGeneration();
	const [{ completed }] = await Promise.all([
		refreshCatalogs(generation.runtime, { force }),
		refreshModelListings(generation.runtime, generation.opaqueProviderIds, { force }),
	]);
	return { models: readAvailableWireModels(generation), complete: completed };
}

function readAvailableWireModels(generation: PiRuntimeGeneration): WireModel[] {
	const authByProvider = new Map<string, WireModelAuth>();
	return settledAvailableModels(generation.runtime).map((model) => {
		let auth = authByProvider.get(model.provider);
		if (!auth) {
			auth = catalogProviderAuth(generation, model.provider);
			authByProvider.set(model.provider, auth);
		}
		return toWireModel(model, auth);
	});
}

export async function clampThinkingForModel(
	ref: Pick<WireModel, "provider" | "id">,
	level: ThinkingLevel,
): Promise<ThinkingLevel> {
	const generation = await getPiRuntimeGeneration();
	return clampThinkingLevel(resolveWireModel(generation.runtime, ref), level);
}

export function isSessionStreaming(sessionId: string): boolean {
	return mustGet(sessionId).isStreaming;
}

export function liveParentContext(sessionId: string): ParentContext | undefined {
	const entry = sessions.get(sessionId);
	if (!entry || !canUseSessionResources(sessionId, entry.workspaceId)) return undefined;
	const { session, workspaceId } = entry;
	return {
		cwd: session.sessionManager.getCwd(),
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		modelRegistry: session.modelRegistry,
		isProjectTrusted: () => entry.settings.projectTrusted && piResourceTrustFor(workspaceId),
	};
}

const pendingCascades = new Map<string, Set<Promise<void>>>();

function trackCascade(workspaceId: string, cascade: Promise<void>): Promise<void> {
	let pending = pendingCascades.get(workspaceId);
	if (!pending) {
		pending = new Set();
		pendingCascades.set(workspaceId, pending);
	}
	const scope = pending;
	const tracked: Promise<void> = cascade.then(() => {
		scope.delete(tracked);
		if (scope.size === 0 && pendingCascades.get(workspaceId) === scope) {
			pendingCascades.delete(workspaceId);
		}
	});
	scope.add(tracked);
	return tracked;
}

const SESSION_SHUTDOWN_BUDGET_MS = 3000;

function settleShutdownStep(entry: Entry, step: () => Promise<unknown>): Promise<void> {
	let running: Promise<unknown>;
	try {
		running = step();
	} catch (error) {
		running = Promise.reject(error);
	}
	return running.then(
		() => {},
		(error) => {
			log.debug(`session ${entry.session.sessionId} shutdown handlers failed`, error as Error);
		},
	);
}

function emitSessionShutdown(entry: Entry, timeoutMs = SESSION_SHUTDOWN_BUDGET_MS): Promise<void> {
	const session = entry.session;
	if (entry.shutdown?.session === session) return entry.shutdown.settled;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const steps = (async () => {
		await settleShutdownStep(entry, () => entry.mcpHost.shutdownEngine());
		await settleShutdownStep(entry, () => session.dispose());
	})();
	const settled = Promise.race([
		steps,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
	entry.shutdown = { session, settled };
	return settled;
}

function closeSessionResources(entry: Entry, timeoutMs?: number): Promise<void> {
	if (entry.resourceCascade) return entry.resourceCascade;
	entry.resourcesClosing = true;
	entry.subagents.dispose();
	const closing = entry.commands.dispose(timeoutMs === undefined ? undefined : { timeoutMs });
	const children = disposeSessionChildren(entry.workspaceId, entry.session.sessionId);
	const childrenSettled = children.catch(() => {});
	entry.childrenClosed =
		timeoutMs === undefined
			? childrenSettled
			: Promise.race([childrenSettled, Bun.sleep(timeoutMs)]);
	const mcp = settleShutdownStep(entry, () => entry.mcpHost.shutdownEngine());
	entry.resourceCascade = trackCascade(
		entry.workspaceId,
		Promise.allSettled([closing, children, mcp]).then(() => {}),
	);
	return entry.resourceCascade;
}

function shutdownEngine(entry: Entry, timeoutMs?: number): Promise<void> {
	const resources = closeSessionResources(entry, timeoutMs);
	const engine = (entry.childrenClosed ?? Promise.resolve()).then(() =>
		emitSessionShutdown(entry, timeoutMs),
	);
	const done = trackCascade(
		entry.workspaceId,
		Promise.allSettled([resources, engine]).then(() => {}),
	);
	void done.then(() => releaseSettleWaiters(entry));
	return done;
}

function trackSessionTeardown(sessionId: string, cascade: Promise<void>): Promise<void> {
	const current = sessionTeardowns.get(sessionId);
	if (current) return current;
	let done: Promise<void>;
	done = cascade.finally(() => {
		if (sessionTeardowns.get(sessionId) === done) sessionTeardowns.delete(sessionId);
	});
	sessionTeardowns.set(sessionId, done);
	return done;
}

function disposeSession(sessionId: string): Promise<void> {
	const pending = sessionTeardowns.get(sessionId);
	if (pending) return pending;
	const entry = sessions.get(sessionId);
	if (!entry) return Promise.resolve();
	entry.disposed = true;
	const cascade = trackSessionTeardown(sessionId, shutdownEngine(entry));
	tearingDownEntries.set(sessionId, entry);
	void cascade.finally(() => {
		if (tearingDownEntries.get(sessionId) === entry) tearingDownEntries.delete(sessionId);
	});
	cancelExtUiForSession(sessionId);
	forgetMcpStatus(sessionId);
	entry.toolResponseWaiters.abandon();
	releaseSettleWaiters(entry);
	entry.unsubscribe();
	entry.unsubscribeCommands();
	clearEntryQueue(entry);
	sessions.delete(sessionId);
	publishSessionResourcesChanged(entry.workspaceId, sessionId);
	log.debug(`session ${sessionId} disposed`);
	return cascade;
}

export function removeSession(sessionId: string): Promise<void> {
	if (hasDeletionTombstone(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
	const pending = sessionTeardowns.get(sessionId);
	if (pending) return pending;
	const entry = sessions.get(sessionId);
	if (!entry) return Promise.resolve();
	closeSessionResources(entry);
	if (entry.session.isStreaming)
		return abortEntry(entry, true)
			.catch(() => {})
			.then(() => disposeSession(sessionId));
	return disposeSession(sessionId);
}

export function disposeAllSessions(): void {
	sessionLifecycleGeneration++;
	workspaceLifecycleGenerations.clear();
	closingWorkspaces.clear();
	for (const [sessionId, entry] of sessions) {
		void trackSessionTeardown(sessionId, shutdownEngine(entry));
	}
	for (const [sessionId, entry] of sessions) {
		cancelExtUiForSession(sessionId);
		forgetMcpStatus(sessionId);
		entry.toolResponseWaiters.abandon();
		releaseSettleWaiters(entry);
		entry.unsubscribe();
		entry.unsubscribeCommands();
		entry.disposed = true;
		clearEntryQueue(entry);
	}
	sessions.clear();
	tearingDownEntries.clear();
	deletedSessions.clear();
}

export async function settleSessionsForShutdown(
	timeoutMs = SESSION_SHUTDOWN_BUDGET_MS,
): Promise<void> {
	const settling = new Set<Promise<unknown>>();
	for (const entry of sessions.values()) settling.add(closeSessionResources(entry, timeoutMs));
	for (const [sessionId, entry] of sessions) {
		clearEntryQueue(entry);
		const acceptedResult = entry.toolResponseWaiters.prepareShutdown();
		const preserved = !acceptedResult && entry.toolResponseWaiters.hasRecoverableCall();
		let stopped: Promise<unknown> = Promise.resolve();
		if (acceptedResult) {
			stopped = acceptedResult
				.catch(() => {})
				.then(async () => {
					if (sessions.get(sessionId) === entry && entry.session.isStreaming) {
						clearEntryQueue(entry);
						await entry.session.abort();
					}
				});
		} else if (entry.session.isStreaming && !preserved) {
			stopped = entry.session.abort();
		}
		settling.add(stopped);
		if (!preserved)
			settling.add(
				stopped
					.then(() => entry.session.waitForIdle())
					.catch(() => {})
					.then(() =>
						sessions.get(sessionId) === entry ? shutdownEngine(entry, timeoutMs) : undefined,
					),
			);
	}
	for (const pending of pendingCascades.values()) {
		for (const cascade of pending) settling.add(cascade);
	}
	if (settling.size === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(settling),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function removeWorkspaceSessionsInternal(workspaceId: string, cwd?: string): Promise<void> {
	workspaceLifecycleGenerations.set(
		workspaceId,
		(workspaceLifecycleGenerations.get(workspaceId) ?? 0) + 1,
	);
	closingWorkspaces.set(workspaceId, (closingWorkspaces.get(workspaceId) ?? 0) + 1);
	try {
		const entries = [...sessions].filter(([, entry]) => entry.workspaceId === workspaceId);
		for (const [, entry] of entries) void closeSessionResources(entry);
		const removals = entries.map(async ([sessionId, entry]) => {
			if (entry.session.isStreaming) await abortEntry(entry, true).catch(() => {});
			await disposeSession(sessionId);
		});
		await Promise.all([
			Promise.allSettled([...(pendingSessionPreparations.get(workspaceId) ?? [])]),
			Promise.all(removals),
		]);
		await Promise.all([...(pendingCascades.get(workspaceId) ?? [])]);
		removeWorkspaceDelegation(workspaceId);
		if (cwd) await purgeDiskSessions(cwd);
	} finally {
		const remainingClosures = (closingWorkspaces.get(workspaceId) ?? 1) - 1;
		if (remainingClosures === 0) closingWorkspaces.delete(workspaceId);
		else closingWorkspaces.set(workspaceId, remainingClosures);
	}
}

export function removeWorkspaceSessions(workspaceId: string, cwd?: string): Promise<void> {
	return removeWorkspaceSessionsInternal(workspaceId, cwd);
}

async function purgeDiskSessions(cwd: string): Promise<void> {
	let infos: Awaited<ReturnType<typeof SessionManager.list>>;
	try {
		infos = await SessionManager.list(cwd);
	} catch {
		return;
	}
	for (const info of infos) {
		if (info.cwd !== cwd) continue;
		rmSync(info.path, { force: true });
		try {
			removeSessionStateMetadata(info.id);
		} catch (error) {
			log.warn(`session state metadata was not pruned for ${info.id}`, error as Error);
		}
	}
}

export function deleteSession(sessionId: string, workspaceId: string, cwd: string): Promise<void> {
	const inFlight = deletingSessions.get(sessionId);
	if (inFlight) {
		if (inFlight.workspaceId !== workspaceId)
			return Promise.reject(new Error(`Unknown session: ${sessionId}`));
		return inFlight.done;
	}

	const transaction = runDeleteTransaction(sessionId, workspaceId, cwd);
	const done = transaction.then(
		() => {
			deletingSessions.delete(sessionId);
		},
		(error: unknown) => {
			deletingSessions.delete(sessionId);
			throw error;
		},
	);
	deletingSessions.set(sessionId, { workspaceId, done });
	return done;
}

async function runDeleteTransaction(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<void> {
	const installedTombstone = !deletedSessions.has(sessionId);
	deletedSessions.set(sessionId, workspaceId);
	let liveEntry: Entry | undefined;
	try {
		await attaching.get(sessionId)?.catch(() => {});
		const entry = sessions.get(sessionId);
		if (entry && entry.workspaceId !== workspaceId) {
			throw new Error(`Unknown session: ${sessionId}`);
		}
		let path: string | undefined;
		if (entry) {
			if (entry.session.isStreaming) await abortEntry(entry, true);
			const manager = entry.session.sessionManager;
			if (manager.getSessionId() !== sessionId || manager.getCwd() !== cwd) {
				throw new Error(`Session transcript scope mismatch: ${sessionId}`);
			}
			path = manager.getSessionFile();
			if (manager.isSessionOnDisk() && !path) {
				throw new Error(`Persisted session has no transcript path: ${sessionId}`);
			}
			liveEntry = entry;
			await manager.flush();
		} else {
			path = (await listSessionInfosStrict(cwd)).find(
				(candidate) => candidate.id === sessionId && candidate.cwd === cwd,
			)?.path;
		}
		await sessionTeardowns.get(sessionId);
		if (path && existsSync(path)) await trashFile(path);
	} catch (error) {
		if (installedTombstone) {
			deletedSessions.delete(sessionId);
			sessions.get(sessionId)?.commands.flushCompletions();
			sessions.get(sessionId)?.subagents.flushCompletions();
			if (sessions.has(sessionId)) reconcileSubagentUsageInBackground(workspaceId, sessionId);
			publishSessionResourcesChanged(workspaceId, sessionId);
		}
		throw error;
	}
	if (liveEntry && sessions.get(sessionId) === liveEntry) {
		liveEntry.session.sessionManager.seal();
		await disposeSession(sessionId);
	}
	try {
		removeSessionStateMetadata(sessionId);
	} catch (error) {
		log.warn(`session state metadata was not pruned for ${sessionId}`, error as Error);
	}
	publishDeleted({ workspaceId, sessionId });
}
