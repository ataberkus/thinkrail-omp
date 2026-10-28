import { resolve } from "node:path";
import { TERMINAL_TOOL_RESULT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	discoverAuthStorage,
	discoverContextFiles,
	type ExtensionFactory,
	getAgentDir,
	loadSkills,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import {
	type ContextFile,
	contextFileCapability,
} from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { captureBranch, captureSession, forkCaptured } from "./history";
import { scanReplayTools } from "./replayTools";
import { assertSlots, Semaphore } from "./semaphore";
import {
	assertSegment,
	DEFAULT_SCOPE,
	defaultDelegationRoot,
	delegationSessionDir,
	locateResourceTranscript,
	resourceSessionDir,
} from "./storage";
import { fromEngineThinking, toEngineThinking } from "./thinking";
import {
	type ChildHandle,
	type CreateChildSpec,
	type DelegationBindings,
	DelegationError,
	type DelegationRunDetails,
	type DelegationService,
	type LifecycleEvent,
	type ParentContext,
	type ResourceChildBirth,
	type ResourceChildHandle,
	type ResourceContextInput,
	type ResourceDelegation,
	type ResourceDelegationOptions,
	type ResourceSpawnRecord,
	type RunLifecycleStatus,
	type RunOptions,
	type RunOutcome,
	type RunSnapshot,
	type RunStatus,
	type SessionOptions,
	type SpawnRecord,
} from "./types";

const DEFAULT_MAX_CONCURRENT_PER_PARENT = 4;

const WRAP_UP_INSTRUCTION =
	"You have reached your turn limit. Stop calling tools now and reply with your final result: " +
	"summarize what you completed, what remains, and any findings.";

interface ActiveRun {
	readonly controller: AbortController;
	readonly settled: Promise<void>;
	readonly resolveSettled: () => void;
	abortReason?: string;
	sessionAbort?: Promise<void>;
}

interface ResourceState {
	readonly id: string;
	context?: Promise<PreparedContext>;
	semaphore?: Semaphore;
	readonly factories: ExtensionFactory[];
	readonly terminalTools: ReadonlySet<string>;
	readonly children: Map<string, ChildEntry>;
	readonly pending: Set<Promise<unknown>>;
	readonly opening: Set<string>;
	closed: boolean;
	release?: Promise<void>;
}

interface PreparedContext {
	cwd: string;
	registry: ModelRegistry;
	model?: SessionOptions["model"];
	thinkingLevel?: SessionOptions["thinkingLevel"];
	isProjectTrusted?: () => boolean;
}

interface ChildEntry {
	readonly record: SpawnRecord | ResourceSpawnRecord;
	readonly semaphore: Semaphore;
	readonly resource?: ResourceState;
	readonly session: AgentSession;
	readonly listeners: Set<(e: LifecycleEvent) => void>;
	handle?: ChildHandle;
	workspaceDispose?: (outcome: { status: RunStatus }) => { resultAddendum?: string } | undefined;
	snapshot?: RunSnapshot;
	activeRun?: ActiveRun;
	teardown?: Promise<void>;
	disposed: boolean;
}

function assertReplayable(manager: SessionManager): void {
	const replay = scanReplayTools(manager.buildSessionContext().messages);
	if (replay.issues.length)
		throw new DelegationError("invalid-child-transcript", replay.issues.join("; "));
}

function abortActiveRun(entry: ChildEntry, reason?: string): Promise<void> {
	const activeRun = entry.activeRun;
	if (!activeRun || (entry.snapshot?.status !== "queued" && entry.snapshot?.status !== "running")) {
		return Promise.resolve();
	}
	if (!activeRun.controller.signal.aborted) {
		if (reason !== undefined) activeRun.abortReason = reason;
		activeRun.controller.abort();
	}
	if (entry.resource) {
		entry.session.clearQueue();
		entry.session.abortCompaction();
		entry.session.abortRetry();
	}
	if (!entry.session.isStreaming) return activeRun.sessionAbort ?? Promise.resolve();
	activeRun.sessionAbort ??= entry.session.abort();
	return activeRun.sessionAbort;
}

function keepParentRegistrations(): void {}

function childRegistry(registry: ModelRegistry): ModelRegistry {
	const bound = new Map<PropertyKey, unknown>();
	return new Proxy(registry, {
		get(target, property) {
			if (property === "syncExtensionSources" || property === "clearSourceRegistrations")
				return keepParentRegistrations;
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			let method = bound.get(property);
			if (method === undefined) {
				method = value.bind(target);
				bound.set(property, method);
			}
			return method;
		},
	});
}

async function childSkills(
	names: readonly string[],
	cwd: string,
	projectTrusted: boolean,
): Promise<Awaited<ReturnType<typeof loadSkills>>["skills"]> {
	if (names.length === 0) return [];
	const { skills } = await loadSkills({ cwd });
	return skills.filter(
		(skill) => names.includes(skill.name) && (projectTrusted || skill._source?.level !== "project"),
	);
}

async function userContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
	const { items } = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });
	const user = new Set(items.filter((item) => item.level === "user").map((item) => item.path));
	return (await discoverContextFiles(cwd)).filter((file) => user.has(file.path));
}

function snapshotSessionOptions(options: SessionOptions): SessionOptions {
	return {
		...(options.model ? { model: { ...options.model } } : {}),
		...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
		...(options.tools ? { tools: [...options.tools] } : {}),
		...(options.excludeTools ? { excludeTools: [...options.excludeTools] } : {}),
		...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
		...(options.contextFiles !== undefined ? { contextFiles: options.contextFiles } : {}),
		...(options.skills ? { skills: [...options.skills] } : {}),
		...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
	};
}

function snapshotChildSpec(spec: Omit<CreateChildSpec, "parent">): Omit<CreateChildSpec, "parent"> {
	let origin: CreateChildSpec["origin"];
	switch (spec.origin?.kind) {
		case "fresh":
			origin = { kind: "fresh" };
			break;
		case "fork":
			origin = {
				kind: "fork",
				sourceSessionId: spec.origin.sourceSessionId,
				...(spec.origin.entryId !== undefined ? { entryId: spec.origin.entryId } : {}),
			};
			break;
		case "fork-captured":
			origin = { kind: "fork-captured", history: { ...spec.origin.history } };
			break;
		case "seeded":
			origin = { kind: "seeded", digest: spec.origin.digest };
			break;
	}
	return {
		visibility: spec.visibility,
		info: { ...spec.info },
		...(origin ? { origin } : {}),
		...(spec.interactive !== undefined ? { interactive: spec.interactive } : {}),
		...(spec.workspace ? { workspace: spec.workspace } : {}),
		...(spec.session ? { session: snapshotSessionOptions(spec.session) } : {}),
	};
}

function assertV1Combination(spec: Omit<CreateChildSpec, "parent">): SessionOptions {
	if (spec.visibility === "hidden" && spec.interactive === true) {
		throw new DelegationError(
			"invalid-combination",
			"hidden + interactive is permanently invalid: an interactive child must be listed so a human can reach it",
		);
	}
	if (spec.visibility === "listed") {
		throw new DelegationError(
			"not-implemented",
			'visibility "listed" has no V1 consumer (subsessions/branching land later); use "hidden"',
		);
	}
	if (spec.interactive === true) {
		throw new DelegationError(
			"not-implemented",
			"interactive children have no V1 consumer (subsessions land later)",
		);
	}
	const originKind = spec.origin?.kind ?? "fresh";
	if (originKind !== "fresh" && originKind !== "fork-captured") {
		throw new DelegationError(
			"not-implemented",
			`origin "${originKind}" has no V1 consumer (branching/seeding land later); use "fresh"`,
		);
	}
	if (!spec.session) {
		throw new DelegationError(
			"not-implemented",
			"parent-like session options (absent `session`) have no V1 consumer — pass explicit SessionOptions",
		);
	}
	if (spec.workspace) {
		throw new DelegationError(
			"not-implemented",
			"WorkspaceProvider has no V1 consumer — children share the parent cwd",
		);
	}
	return spec.session;
}

async function acquireOrAbort(
	semaphore: Semaphore,
	signal: AbortSignal | undefined,
): Promise<(() => void) | undefined> {
	const slot = semaphore.acquire();
	if (!signal) return slot;
	const releaseEventually = () => void slot.then((release) => release());
	if (signal.aborted) {
		releaseEventually();
		return undefined;
	}
	let onAbort = () => {};
	const aborted = new Promise<undefined>((resolveAborted) => {
		onAbort = () => resolveAborted(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	const winner = await Promise.race([slot, aborted]);
	signal.removeEventListener("abort", onAbort);
	if (winner === undefined) releaseEventually();
	return winner;
}

interface RunBaseline {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function baselineOf(session: AgentSession): RunBaseline {
	const { input, output, cacheRead, cacheWrite, cost } =
		session.sessionManager.getUsageStatistics();
	return { input, output, cacheRead, cacheWrite, cost };
}

function textOf(message: AssistantMessage | undefined): string | undefined {
	if (!message) return undefined;
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

export function createDelegationService(bindings: DelegationBindings): DelegationService {
	const delegationRoot = bindings.delegationRoot ?? defaultDelegationRoot();
	const scope = bindings.scope ?? DEFAULT_SCOPE;
	let slotsPerParent = bindings.maxConcurrentPerParent ?? DEFAULT_MAX_CONCURRENT_PER_PARENT;

	const children = new Map<string, ChildEntry>();
	const resources = new Map<string, ResourceState>();
	const byParent = new Map<string, Set<string>>();
	const semaphores = new Map<string, Semaphore>();
	const lifecycleListeners = new Set<(e: LifecycleEvent) => void>();
	const parentLifetimes = new Map<string, object>();
	const pendingParentPreparations = new Map<object, Set<Promise<void>>>();

	let fallbackRegistry: Promise<ModelRegistry> | undefined;

	function parentLifetimeFor(parentSessionId: string): object {
		let lifetime = parentLifetimes.get(parentSessionId);
		if (!lifetime) {
			lifetime = {};
			parentLifetimes.set(parentSessionId, lifetime);
		}
		return lifetime;
	}

	function beginParentPreparation(parentSessionId: string): {
		lifetime: object;
		complete(): void;
	} {
		const lifetime = parentLifetimeFor(parentSessionId);
		let finish = () => {};
		const settled = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let pending = pendingParentPreparations.get(lifetime);
		if (!pending) {
			pending = new Set();
			pendingParentPreparations.set(lifetime, pending);
		}
		const scope = pending;
		scope.add(settled);
		let completed = false;
		return {
			lifetime,
			complete() {
				if (completed) return;
				completed = true;
				finish();
				scope.delete(settled);
				if (scope.size === 0) pendingParentPreparations.delete(lifetime);
				if (
					parentLifetimes.get(parentSessionId) === lifetime &&
					!byParent.has(parentSessionId) &&
					!pendingParentPreparations.has(lifetime)
				)
					parentLifetimes.delete(parentSessionId);
			},
		};
	}

	async function registryFor(parent: ParentContext): Promise<ModelRegistry> {
		if (parent.modelRegistry) return parent.modelRegistry;
		const bound = bindings.modelRegistry;
		if (typeof bound === "function") return bound();
		if (bound) return bound;
		fallbackRegistry ??= discoverAuthStorage(getAgentDir()).then((authStorage) => {
			const registry = new ModelRegistry(authStorage);
			registry.refreshInBackground();
			return registry;
		});
		return fallbackRegistry;
	}

	function semaphoreFor(parentSessionId: string): Semaphore {
		let semaphore = semaphores.get(parentSessionId);
		if (!semaphore) {
			semaphore = new Semaphore(slotsPerParent);
			semaphores.set(parentSessionId, semaphore);
		}
		return semaphore;
	}

	function emit(event: LifecycleEvent, entry: ChildEntry): void {
		for (const listener of lifecycleListeners) listener(event);
		for (const listener of entry.listeners) listener(event);
	}

	function emitRun(entry: ChildEntry, type: "run-queued" | "run-started"): void {
		if ("parentSessionId" in entry.record)
			emit(
				{ type, sessionId: entry.record.sessionId, parentSessionId: entry.record.parentSessionId },
				entry,
			);
	}

	function steerResource(entry: ChildEntry, activeRun: ActiveRun | undefined, text: string): void {
		if (entry.disposed)
			throw new DelegationError("disposed", `Child ${entry.record.sessionId} is disposed`);
		if (
			!activeRun ||
			entry.activeRun !== activeRun ||
			activeRun.controller.signal.aborted ||
			!entry.session.isStreaming
		) {
			throw new DelegationError(
				"not-running",
				"Resource steering requires an active streaming invocation",
			);
		}
		entry.session.agent.steer({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
	}

	function buildDetails(
		entry: ChildEntry,
		task: string,
		status: RunLifecycleStatus,
		turns: number,
		activity: string | undefined,
		startedAt: number,
		baseline: RunBaseline,
	): DelegationRunDetails {
		const { session, record } = entry;
		const stats = session.sessionManager.getUsageStatistics();
		const thinkingLevel = fromEngineThinking(session.thinkingLevel ?? "off");
		return {
			childSessionId: record.sessionId,
			...(record.info.roleName !== undefined ? { roleName: record.info.roleName } : {}),
			...(record.info.roleSource !== undefined ? { roleSource: record.info.roleSource } : {}),
			task,
			status,
			...(session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}),
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
			usage: {
				input: stats.input - baseline.input,
				output: stats.output - baseline.output,
				cacheRead: stats.cacheRead - baseline.cacheRead,
				cacheWrite: stats.cacheWrite - baseline.cacheWrite,
				cost: stats.cost - baseline.cost,
				turns,
				contextTokens: session.getContextUsage()?.tokens ?? 0,
			},
			durationMs: Date.now() - startedAt,
			...(activity !== undefined ? { activity } : {}),
			...(entry.activeRun?.abortReason !== undefined
				? { abortReason: entry.activeRun.abortReason }
				: {}),
		};
	}

	async function driveRun(
		entry: ChildEntry,
		task: string,
		opts: RunOptions,
		baseline: RunBaseline,
		startedAt: number,
	): Promise<RunOutcome> {
		const { session } = entry;
		const cap = opts.maxTurns;
		let turns = 0;
		let activity: string | undefined;
		let capSteered = false;
		let abortRequested = false;
		let last: AssistantMessage | undefined;
		const activeRun = entry.activeRun;

		const pushUpdate = (status: RunLifecycleStatus) => {
			const details = buildDetails(entry, task, status, turns, activity, startedAt, baseline);
			if (entry.snapshot?.task === task) entry.snapshot = { ...entry.snapshot, status, details };
			opts.onUpdate?.(details);
			if ("parentSessionId" in entry.record)
				emit(
					{
						type: "run-progress",
						sessionId: entry.record.sessionId,
						parentSessionId: entry.record.parentSessionId,
						details,
					},
					entry,
				);
		};

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				last = event.message;
			}
			if (opts.signal?.aborted && event.type === "agent_start") {
				session.clearQueue();
				session.agent.abort();
			}
			if (event.type === "tool_execution_start") {
				activity = event.toolName;
				pushUpdate("running");
			} else if (event.type === "turn_end") {
				turns++;
				const continues =
					event.message.role === "assistant" &&
					event.message.content.some((block) => block.type === "toolCall");
				if (cap !== undefined && turns >= cap && continues && !capSteered) {
					capSteered = true;
					if (entry.resource) {
						try {
							steerResource(entry, activeRun, WRAP_UP_INSTRUCTION);
						} catch {}
					} else void session.steer(WRAP_UP_INSTRUCTION).catch(() => {});
				}
				pushUpdate("running");
			} else if (event.type === "turn_start") {
				if (cap !== undefined && turns > cap) {
					abortRequested = true;
					void abortActiveRun(entry).catch(() => {});
				}
			}
		});

		const onAbort = () => {
			abortRequested = true;
			void abortActiveRun(entry).catch(() => {});
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.signal?.aborted) onAbort();

		let thrownMessage: string | undefined;
		try {
			let text: string | undefined = task;
			const runner = session.extensionRunner;
			if (!abortRequested && runner?.hasHandlers("input")) {
				const input = await runner.emitInput(
					task,
					undefined,
					entry.resource ? "extension" : "interactive",
				);
				text = input.handled ? undefined : (input.text ?? task);
			}
			if (activeRun?.controller.signal.aborted) abortRequested = true;
			if (!abortRequested && text !== undefined) {
				await session.sessionManager.ensureOnDisk();
				await session.prompt(text, entry.resource ? { expandPromptTemplates: false } : undefined);
			}
		} catch (error) {
			thrownMessage = error instanceof Error ? error.message : String(error);
		} finally {
			unsubscribe();
			opts.signal?.removeEventListener("abort", onAbort);
			session.clearQueue();
		}

		let status: RunStatus;
		let errorMessage = thrownMessage;
		if (abortRequested || last?.stopReason === "aborted") {
			status = "aborted";
		} else if (thrownMessage !== undefined || last?.stopReason === "error") {
			status = "error";
			errorMessage ??= last?.errorMessage;
		} else {
			status = "completed";
		}
		const finalText = textOf(last);
		const details = buildDetails(entry, task, status, turns, activity, startedAt, baseline);
		return {
			historyEntryId: session.sessionManager.getLeafId(),
			...(last ? { stopReason: last.stopReason } : {}),
			status,
			...(finalText !== undefined ? { finalText } : {}),
			details,
			...(errorMessage !== undefined ? { errorMessage } : {}),
		};
	}

	async function runQueued(entry: ChildEntry, task: string, opts: RunOptions): Promise<RunOutcome> {
		if (entry.disposed) {
			throw new DelegationError("disposed", `Child ${entry.record.sessionId} is disposed`);
		}
		if (entry.activeRun) {
			throw new DelegationError(
				"already-running",
				`Child ${entry.record.sessionId} already has a run in flight — steer() it instead`,
			);
		}
		let resolveSettled = () => {};
		const activeRun: ActiveRun = {
			controller: new AbortController(),
			settled: new Promise<void>((resolve) => {
				resolveSettled = resolve;
			}),
			resolveSettled: () => resolveSettled(),
		};
		entry.activeRun = activeRun;
		const forwardCallerAbort = () => activeRun.controller.abort(opts.signal?.reason);
		if (opts.signal?.aborted) forwardCallerAbort();
		else opts.signal?.addEventListener("abort", forwardCallerAbort, { once: true });
		const runOpts: RunOptions = { ...opts, signal: activeRun.controller.signal };

		try {
			const startedAt = Date.now();
			const baseline = baselineOf(entry.session);
			const queuedDetails = buildDetails(entry, task, "queued", 0, undefined, startedAt, baseline);
			entry.snapshot = {
				status: "queued",
				task,
				details: queuedDetails,
				collected: false,
			};
			emitRun(entry, "run-queued");
			const release = await acquireOrAbort(entry.semaphore, runOpts.signal);
			try {
				let outcome: RunOutcome;
				if (release === undefined || entry.disposed || runOpts.signal?.aborted) {
					outcome = {
						status: "aborted",
						historyEntryId: entry.session.sessionManager.getLeafId(),
						details: buildDetails(entry, task, "aborted", 0, undefined, startedAt, baseline),
						errorMessage: entry.disposed ? "disposed before start" : "aborted before start",
					};
				} else {
					const runStartedAt = Date.now();
					const runningDetails = buildDetails(
						entry,
						task,
						"running",
						0,
						undefined,
						runStartedAt,
						baseline,
					);
					entry.snapshot = { ...entry.snapshot, status: "running", details: runningDetails };
					runOpts.onUpdate?.(runningDetails);
					emitRun(entry, "run-started");
					outcome = await driveRun(entry, task, runOpts, baseline, runStartedAt);
				}
				entry.session.clearQueue();
				entry.snapshot = {
					status: outcome.status,
					task,
					details: outcome.details,
					...(outcome.finalText !== undefined ? { finalText: outcome.finalText } : {}),
					...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
					collected: false,
				};
				if ("parentSessionId" in entry.record)
					emit(
						{
							type: "run-terminal",
							sessionId: entry.record.sessionId,
							parentSessionId: entry.record.parentSessionId,
							outcome,
						},
						entry,
					);
				return outcome;
			} finally {
				release?.();
			}
		} finally {
			entry.session.clearQueue();
			opts.signal?.removeEventListener("abort", forwardCallerAbort);
			activeRun.resolveSettled();
			if (entry.activeRun === activeRun) delete entry.activeRun;
		}
	}

	function disposeChild(entry: ChildEntry): Promise<void> {
		entry.disposed = true;
		void abortActiveRun(entry).catch(() => {});
		entry.teardown ??= Promise.resolve().then(() => teardownChild(entry));
		return entry.teardown;
	}

	async function teardownChild(entry: ChildEntry): Promise<void> {
		const activeRun = entry.activeRun;
		if (activeRun) {
			await abortActiveRun(entry).catch(() => {});
			await activeRun.settled;
		}
		if (entry.session.isStreaming) await entry.session.abort().catch(() => {});
		const lastStatus = entry.snapshot?.status;
		const terminal: RunStatus =
			lastStatus === "completed" || lastStatus === "error" ? lastStatus : "aborted";
		const teardown = entry.workspaceDispose?.({ status: terminal });
		if (teardown?.resultAddendum && entry.snapshot) {
			const finalText = [entry.snapshot.finalText, teardown.resultAddendum]
				.filter((part): part is string => part !== undefined)
				.join("\n\n");
			entry.snapshot = { ...entry.snapshot, finalText };
		}
		try {
			await entry.session.dispose();
		} finally {
			if ("parentSessionId" in entry.record) {
				children.delete(entry.record.sessionId);
				byParent.get(entry.record.parentSessionId)?.delete(entry.record.sessionId);
				emit(
					{
						type: "child-disposed",
						sessionId: entry.record.sessionId,
						parentSessionId: entry.record.parentSessionId,
					},
					entry,
				);
			} else entry.resource?.children.delete(entry.record.sessionId);
		}
	}

	function makeHandle(entry: ChildEntry): ChildHandle {
		const record = entry.record;
		if (!("parentSessionId" in record))
			throw new DelegationError("invalid-child-record", "Not a parent child");
		return {
			get sessionId() {
				return entry.record.sessionId;
			},
			get record() {
				return record;
			},
			get snapshot() {
				return entry.snapshot;
			},
			runQueued: (task, opts = {}) => runQueued(entry, task, opts),
			runNow: () => {
				throw new DelegationError(
					"not-implemented",
					"runNow has no V1 consumer (workflow engines land later) — use runQueued",
				);
			},
			steer: async (text) => {
				if (entry.disposed) {
					throw new DelegationError("disposed", `Child ${entry.record.sessionId} is disposed`);
				}
				await entry.session.steer(text);
			},
			abort: async (reason) => {
				if (entry.disposed) return;
				await abortActiveRun(entry, reason);
			},
			dispose: () => disposeChild(entry),
			onEvent: (listener) => {
				entry.listeners.add(listener);
				return () => entry.listeners.delete(listener);
			},
			collectResult: () => {
				const snapshot = entry.snapshot;
				if (
					snapshot &&
					(snapshot.status === "completed" ||
						snapshot.status === "error" ||
						snapshot.status === "aborted")
				) {
					entry.snapshot = { ...snapshot, collected: true };
					return entry.snapshot;
				}
				return snapshot;
			},
		};
	}

	const trustOf = (context: { isProjectTrusted?: () => boolean }): boolean =>
		context.isProjectTrusted?.() ?? true;

	async function assemble(
		options: SessionOptions,
		cwd: string,
		projectTrusted: boolean,
		registry: ModelRegistry,
		model: AgentSession["model"],
		thinkingLevel: SessionOptions["thinkingLevel"],
		factories: ExtensionFactory[],
		manager: SessionManager,
		roleName: string | undefined,
		terminalTools: ReadonlySet<string> = new Set(),
	): Promise<AgentSession> {
		const settings = bindings.buildChildSettings
			? await bindings.buildChildSettings(cwd, projectTrusted)
			: projectTrusted
				? await Settings.loadReadOnly({ cwd, agentDir: getAgentDir() })
				: Settings.isolated();
		const untrustedPrompt =
			options.systemPrompt === undefined && !projectTrusted && bindings.childSystemPrompt
				? await bindings.childSystemPrompt(cwd)
				: {};
		const loadContext = options.contextFiles === true;
		const contextFiles =
			loadContext && !projectTrusted ? { contextFiles: await userContextFiles(cwd) } : {};
		const sessionId = manager.getSessionId();
		let assembled: AgentSession | undefined;
		const endsInvocation: ExtensionFactory = (pi) => {
			pi.on("tool_result", (event) => {
				if (!event.isError && terminalTools.has(event.toolName))
					assembled?.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
				return undefined;
			});
		};
		const { session } = await createAgentSession({
			cwd,
			agentDir: getAgentDir(),
			settings,
			modelRegistry: childRegistry(registry),
			sessionManager: manager,
			...(model ? { model } : {}),
			...(thinkingLevel !== undefined ? { thinkingLevel: toEngineThinking(thinkingLevel) } : {}),
			...(options.systemPrompt !== undefined
				? { customSystemPrompt: options.systemPrompt }
				: untrustedPrompt),
			...(options.tools !== undefined
				? { toolNames: options.tools.filter((name) => !options.excludeTools?.includes(name)) }
				: {}),
			extensions: [
				...(bindings.childBaseExtensionFactories ?? []),
				...(options.extensions === true ? factories : []),
				...(terminalTools.size > 0 ? [endsInvocation] : []),
			],
			disableExtensionDiscovery: true,
			preloadedCustomToolPaths: [],
			skills: await childSkills(options.skills ?? [], cwd, projectTrusted),
			rules: [],
			...contextFiles,
			...(loadContext && projectTrusted ? {} : { noContextFiles: true }),
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			hasUI: false,
			bindProcessState: false,
			cacheWarming: false,
			taskDepth: 1,
			parentTaskPrefix: sessionId,
			agentId: sessionId,
			agentDisplayName: roleName ?? "delegation",
		});
		assembled = session;
		try {
			const effectiveModel = session.model;
			const savedContext = manager.buildSessionContext();
			if (
				effectiveModel &&
				savedContext.models.default !== `${effectiveModel.provider}/${effectiveModel.id}`
			)
				manager.appendModelChange(`${effectiveModel.provider}/${effectiveModel.id}`);
			if (savedContext.thinkingLevel !== (session.thinkingLevel ?? "off"))
				manager.appendThinkingLevelChange(session.thinkingLevel);
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: () => {},
			});
			await applyToolPolicy(session, options);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	async function applyToolPolicy(session: AgentSession, options: SessionOptions): Promise<void> {
		if (options.tools === undefined && options.excludeTools === undefined) return;
		await session.runToolRegistryMutation(async () => {});
		const allowed = options.tools === undefined ? undefined : new Set(options.tools);
		const excluded = new Set(options.excludeTools ?? []);
		const extensionTools = new Set(
			(session.extensionRunner?.getAllRegisteredTools() ?? []).map((tool) => tool.definition.name),
		);
		const enabled = session.getEnabledToolNames();
		const next = enabled.filter(
			(name) =>
				!excluded.has(name) &&
				(allowed === undefined || allowed.has(name) || !extensionTools.has(name)),
		);
		if (next.length !== enabled.length) await session.setActiveToolsByName(next);
	}

	async function newManager(
		spec: Omit<CreateChildSpec, "parent">,
		cwd: string,
		dir: string,
	): Promise<SessionManager> {
		return spec.origin?.kind === "fork-captured"
			? forkCaptured(spec.origin.history, cwd, dir)
			: SessionManager.create(cwd, dir);
	}

	function birthFields(spec: Omit<CreateChildSpec, "parent">, session: AgentSession) {
		return {
			sessionId: session.sessionId,
			scope,
			originKind: spec.origin?.kind === "fork-captured" ? ("fork" as const) : ("fresh" as const),
			...(spec.origin?.kind === "fork-captured" && spec.origin.history.entryId !== null
				? { entryId: spec.origin.history.entryId }
				: {}),
			info: Object.freeze({ ...spec.info }),
			interactive: false,
			visibility: "hidden" as const,
			createdAt: new Date().toISOString(),
			sessionFile: session.sessionManager.getSessionFile() ?? "",
		};
	}

	async function createChild(input: CreateChildSpec): Promise<ChildHandle> {
		const preparation = beginParentPreparation(input.parent);
		try {
			return await createChildInLifetime(input, preparation.lifetime);
		} finally {
			preparation.complete();
		}
	}

	async function createChildInLifetime(
		input: CreateChildSpec,
		parentLifetime: object,
	): Promise<ChildHandle> {
		const parentSessionId = input.parent;
		const spec = snapshotChildSpec(input);
		const options = assertV1Combination(spec);
		const parent = bindings.resolveParent?.(parentSessionId);
		if (!parent)
			throw new DelegationError(
				"unknown-parent",
				`Parent session ${parentSessionId} is not live — children derive their defaults from a live parent`,
			);
		const registry = await registryFor(parent);
		const model = options.model
			? registry.find(options.model.provider, options.model.id)
			: parent.model;
		if (options.model && !model)
			throw new Error(
				`Unknown model ${options.model.provider}/${options.model.id} — resolve against available models before createChild`,
			);
		const manager = await newManager(
			spec,
			parent.cwd,
			delegationSessionDir(delegationRoot, scope, parentSessionId),
		);
		const projectTrusted = trustOf(parent);
		const session = await assemble(
			options,
			parent.cwd,
			projectTrusted,
			registry,
			model,
			options.thinkingLevel ?? fromEngineThinking(parent.thinkingLevel),
			bindings.childExtensionFactories ?? [],
			manager,
			spec.info.roleName,
		);
		const current = bindings.resolveParent?.(parentSessionId);
		const parentClosed = parentLifetimes.get(parentSessionId) !== parentLifetime || !current;
		const trustChanged = current !== undefined && projectTrusted !== trustOf(current);
		if (parentClosed || trustChanged) {
			await session.dispose();
			throw new DelegationError(
				"unknown-parent",
				parentClosed
					? `Parent session ${parentSessionId} closed during child preparation`
					: `Project trust changed during child preparation for ${parentSessionId}`,
			);
		}
		const record: SpawnRecord = Object.freeze({
			...birthFields(spec, session),
			parentSessionId,
		});
		const entry: ChildEntry = {
			record,
			session,
			semaphore: semaphoreFor(parentSessionId),
			listeners: new Set(),
			disposed: false,
		};
		const handle = makeHandle(entry);
		entry.handle = handle;
		children.set(record.sessionId, entry);
		let siblings = byParent.get(parentSessionId);
		if (!siblings) {
			siblings = new Set();
			byParent.set(parentSessionId, siblings);
		}
		siblings.add(record.sessionId);
		emit({ type: "child-created", record }, entry);
		return handle;
	}

	function checkModel(
		context: PreparedContext,
		reference: SessionOptions["model"],
	): NonNullable<AgentSession["model"]> {
		if (!reference || typeof reference.provider !== "string" || typeof reference.id !== "string") {
			throw new DelegationError("model-unavailable", "An effective resource model is required");
		}
		const model = context.registry.find(reference.provider, reference.id);
		if (!model)
			throw new DelegationError(
				"model-unavailable",
				`Unknown model ${reference.provider}/${reference.id}`,
			);
		return model;
	}

	async function prepareContext(input: ResourceContextInput): Promise<PreparedContext> {
		if (typeof input.cwd !== "string" || !input.cwd)
			throw new DelegationError("invalid-combination", "Resource cwd is required");
		return {
			cwd: input.cwd,
			registry: input.modelRegistry,
			...(input.model ? { model: { ...input.model } } : {}),
			...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
			...(input.isProjectTrusted ? { isProjectTrusted: input.isProjectTrusted } : {}),
		};
	}

	function preparedContext(resource: ResourceState): Promise<PreparedContext> {
		assertOpen(resource);
		if (!resource.context) throw new DelegationError("disposed", "Resource context was released");
		return resource.context;
	}

	function assertOpen(resource: ResourceState): void {
		if (resource.closed)
			throw new DelegationError("disposed", `Resource ${resource.id} is released`);
	}

	function track<T>(resource: ResourceState, operation: () => Promise<T>): Promise<T> {
		assertOpen(resource);
		const pending = operation();
		resource.pending.add(pending);
		void pending.then(
			() => resource.pending.delete(pending),
			() => resource.pending.delete(pending),
		);
		return pending;
	}

	function validateSessionOptions(options: SessionOptions): void {
		if (
			!options ||
			typeof options !== "object" ||
			[options.tools, options.excludeTools, options.skills].some(
				(value) =>
					value !== undefined &&
					(!Array.isArray(value) || value.some((item) => typeof item !== "string")),
			) ||
			(options.model !== undefined &&
				(!options.model ||
					typeof options.model.provider !== "string" ||
					!options.model.provider ||
					typeof options.model.id !== "string" ||
					!options.model.id)) ||
			(options.systemPrompt !== undefined && typeof options.systemPrompt !== "string") ||
			(options.contextFiles !== undefined && typeof options.contextFiles !== "boolean") ||
			(options.extensions !== undefined && typeof options.extensions !== "boolean") ||
			(options.thinkingLevel !== undefined &&
				!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
					options.thinkingLevel,
				))
		) {
			throw new DelegationError("invalid-child-record", "Invalid saved session configuration");
		}
	}

	function validateBirth(resource: ResourceState, birth: ResourceChildBirth): ResourceChildBirth {
		if (
			!birth ||
			birth.resourceId !== resource.id ||
			birth.scope !== scope ||
			birth.visibility !== "hidden" ||
			birth.interactive !== false ||
			(birth.originKind !== "fresh" && birth.originKind !== "fork") ||
			!birth.info ||
			typeof birth.info.createdBy !== "string" ||
			!birth.info.createdBy ||
			(birth.info.roleName !== undefined && typeof birth.info.roleName !== "string") ||
			(birth.info.roleSource !== undefined && typeof birth.info.roleSource !== "string") ||
			typeof birth.createdAt !== "string" ||
			!Number.isFinite(Date.parse(birth.createdAt)) ||
			("entryId" in birth &&
				(birth.originKind !== "fork" || typeof birth.entryId !== "string" || !birth.entryId))
		) {
			throw new DelegationError("invalid-child-record", "Invalid resource child birth metadata");
		}
		assertSegment(birth.sessionId, "invalid-child-record");
		return Object.freeze({
			sessionId: birth.sessionId,
			resourceId: birth.resourceId,
			scope: birth.scope,
			originKind: birth.originKind,
			...(birth.entryId !== undefined ? { entryId: birth.entryId } : {}),
			info: Object.freeze({ ...birth.info }),
			interactive: birth.interactive,
			visibility: birth.visibility,
			createdAt: birth.createdAt,
		});
	}

	async function createResourceChild(
		resource: ResourceState,
		input: Omit<CreateChildSpec, "parent">,
		birth?: ResourceChildBirth,
	): Promise<ResourceChildHandle> {
		const spec = snapshotChildSpec(input);
		const options = assertV1Combination(spec);
		validateSessionOptions(options);
		if (
			!spec.info ||
			typeof spec.info.createdBy !== "string" ||
			!spec.info.createdBy ||
			(spec.info.roleName !== undefined && typeof spec.info.roleName !== "string") ||
			(spec.info.roleSource !== undefined && typeof spec.info.roleSource !== "string")
		) {
			throw new DelegationError("invalid-child-record", "Invalid resource child info");
		}
		const context = await preparedContext(resource);
		assertOpen(resource);
		const model = checkModel(context, options.model ?? context.model);
		const dir = resourceSessionDir(delegationRoot, scope, resource.id);
		let manager: SessionManager;
		if (birth) {
			const located = locateResourceTranscript(delegationRoot, scope, resource.id, birth.sessionId);
			manager = await SessionManager.open(located.file, dir);
			if (manager.getCwd() !== resolve(context.cwd)) manager.setCwdWithoutRelocation(context.cwd);
			if (manager.getSessionId() !== birth.sessionId) {
				throw new DelegationError(
					"invalid-child-transcript",
					"Transcript identity changed while reopening",
				);
			}
			assertReplayable(manager);
		} else manager = await newManager(spec, context.cwd, dir);
		const session = await assemble(
			options,
			context.cwd,
			trustOf(context),
			context.registry,
			model,
			options.thinkingLevel ?? context.thinkingLevel,
			[...(bindings.childExtensionFactories ?? []), ...resource.factories],
			manager,
			spec.info.roleName,
			resource.terminalTools,
		);
		const record: ResourceSpawnRecord = Object.freeze(
			birth
				? { ...birth, sessionFile: manager.getSessionFile() ?? "" }
				: { ...birthFields(spec, session), resourceId: resource.id },
		);
		const semaphore = resource.semaphore;
		if (!semaphore) {
			await session.dispose();
			throw new DelegationError("disposed", "Resource pacing was released");
		}
		const entry: ChildEntry = {
			record,
			session,
			resource,
			semaphore,
			listeners: new Set(),
			disposed: false,
		};
		resource.children.set(record.sessionId, entry);
		if (resource.closed) {
			await disposeChild(entry);
			throw new DelegationError("disposed", `Resource ${resource.id} released during assembly`);
		}
		return {
			sessionId: record.sessionId,
			record,
			runQueued: (task, opts = {}) => runQueued(entry, task, opts),
			steer: async (text) => steerResource(entry, entry.activeRun, text),
			abort: async () => {
				const activeRun = entry.activeRun;
				await abortActiveRun(entry);
				await activeRun?.settled;
			},
			dispose: () => disposeChild(entry),
		};
	}

	function releaseResource(resource: ResourceState): Promise<void> {
		resource.closed = true;
		for (const entry of resource.children.values()) entry.disposed = true;
		for (const entry of resource.children.values()) void abortActiveRun(entry).catch(() => {});
		resource.release ??= (async () => {
			await Promise.allSettled([...resource.pending]);
			const settled = await Promise.allSettled([...resource.children.values()].map(disposeChild));
			resources.delete(resource.id);
			resource.factories.length = 0;
			delete resource.context;
			delete resource.semaphore;
			const failed = settled.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		})();
		return resource.release;
	}

	async function registerResource(
		id: string,
		input: ResourceContextInput,
		options: ResourceDelegationOptions = {},
	): Promise<ResourceDelegation> {
		resourceSessionDir(delegationRoot, scope, id);
		if (resources.has(id))
			throw new DelegationError("resource-exists", `Resource ${id} is already registered`);
		const semaphore = new Semaphore(options.maxConcurrent ?? slotsPerParent);
		const resource: ResourceState = {
			id,
			context: prepareContext(input),
			semaphore,
			factories: [...(options.childExtensionFactories ?? [])],
			terminalTools: new Set(options.terminalTools ?? []),
			children: new Map(),
			pending: new Set(),
			opening: new Set(),
			closed: false,
		};
		resources.set(id, resource);
		try {
			const context = await preparedContext(resource);
			if (context.model) checkModel(context, context.model);
		} catch (error) {
			await releaseResource(resource);
			throw error;
		}
		return {
			validateModels: async (models) => {
				const admitted = models.map((model) => ({ ...model }));
				return track(resource, async () => {
					const context = await preparedContext(resource);
					assertOpen(resource);
					for (const model of admitted) checkModel(context, model);
				});
			},
			createChild: async (spec) => track(resource, () => createResourceChild(resource, spec)),
			reopenChild: async ({ birth: inputBirth, session }) =>
				track(resource, async () => {
					const birth = validateBirth(resource, inputBirth);
					if (resource.children.has(birth.sessionId) || resource.opening.has(birth.sessionId))
						throw new DelegationError("invalid-child-record", "Child is already live or opening");
					resource.opening.add(birth.sessionId);
					try {
						return await createResourceChild(
							resource,
							{
								info: birth.info,
								visibility: birth.visibility,
								interactive: birth.interactive,
								session,
							},
							birth,
						);
					} finally {
						resource.opening.delete(birth.sessionId);
					}
				}),
			release: () => releaseResource(resource),
		};
	}

	return {
		registerResource,
		captureHistory: async (source) => {
			if (source.kind === "session") {
				try {
					return captureSession(source);
				} catch (error) {
					if (error instanceof DelegationError) throw error;
					throw new DelegationError(
						"history-unavailable",
						`Cannot read session evidence: ${String(error)}`,
					);
				}
			}
			const resource = resources.get(source.resourceId);
			if (resource?.opening.has(source.sessionId))
				throw new DelegationError("source-busy", "Resource child is opening");
			const live = resource?.children.get(source.sessionId);
			if (live && (live.activeRun || live.disposed || live.teardown))
				throw new DelegationError("source-busy", "Resource child has work or teardown in flight");
			try {
				const { transcript } = locateResourceTranscript(
					delegationRoot,
					scope,
					source.resourceId,
					source.sessionId,
				);
				return captureBranch(transcript, source.entryId);
			} catch (error) {
				if (error instanceof DelegationError && error.code === "child-transcript-unavailable")
					throw new DelegationError("history-unavailable", error.message);
				if (
					error instanceof DelegationError &&
					(error.code === "invalid-child-transcript" || error.code === "invalid-child-record")
				)
					throw new DelegationError("invalid-history", error.message);
				throw error;
			}
		},
		createChild,
		setMaxConcurrentPerParent: (slots) => {
			assertSlots(slots);
			slotsPerParent = slots;
			for (const semaphore of semaphores.values()) semaphore.resize(slots);
		},
		findChild: (sessionId) => children.get(sessionId)?.handle,
		childrenOf: (parentSessionId) => {
			const ids = byParent.get(parentSessionId);
			if (!ids) return [];
			const handles: ChildHandle[] = [];
			for (const id of ids) {
				const handle = children.get(id)?.handle;
				if (handle) handles.push(handle);
			}
			return handles;
		},
		onLifecycle: (listener) => {
			lifecycleListeners.add(listener);
			return () => lifecycleListeners.delete(listener);
		},
		disposeChildrenOf: async (parentSessionId) => {
			const retiringLifetime = parentLifetimes.get(parentSessionId);
			const replacementLifetime = {};
			parentLifetimes.set(parentSessionId, replacementLifetime);
			const preparations = retiringLifetime
				? [...(pendingParentPreparations.get(retiringLifetime) ?? [])]
				: [];
			const lineage = byParent.get(parentSessionId);
			byParent.delete(parentSessionId);
			semaphores.delete(parentSessionId);
			const entries = [...(lineage ?? [])].flatMap((id) => {
				const entry = children.get(id);
				return entry ? [entry] : [];
			});
			for (const entry of entries) entry.disposed = true;
			for (const entry of entries) void abortActiveRun(entry).catch(() => {});
			try {
				await Promise.all([...entries.map(disposeChild), ...preparations]);
			} finally {
				if (
					parentLifetimes.get(parentSessionId) === replacementLifetime &&
					!byParent.has(parentSessionId) &&
					!pendingParentPreparations.has(replacementLifetime)
				)
					parentLifetimes.delete(parentSessionId);
			}
		},
	};
}
