import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import {
	createAgentSession,
	type ExtensionFactory,
	type ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
	createFauxCore,
	createFauxModelRegistry,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
} from "pi-faux";
import {
	type CapturedHistory,
	createDelegationService,
	DelegationError,
	type DelegationErrorCode,
	type ResourceChildBirth,
	type SessionOptions,
	scanReplayTools,
} from "../index";

const root = mkdtempSync(join(tmpdir(), "delegation-resource-"));
const cwd = join(root, "cwd");
const faux = createFauxCore({
	provider: "resource-faux",
	api: "resource-faux",
	tokensPerSecond: 100_000,
	models: [
		{
			id: "worker",
			name: "Worker",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
		},
	],
});
let runtime: ModelRegistry;
let agentDir: IsolatedAgentDir | undefined;
let priorOffline: string | undefined;
const model = { provider: "resource-faux", id: "worker" };
const sessionOptions: SessionOptions = {
	tools: [],
	model,
	thinkingLevel: "high",
	systemPrompt: "Independent worker",
};
const spec = {
	visibility: "hidden" as const,
	info: { createdBy: "workflow:test" },
	session: sessionOptions,
};
const extensionSpec = { ...spec, session: { ...sessionOptions, extensions: true } };
let serial = 0;
function service() {
	return createDelegationService({ delegationRoot: root, scope: `scope-${serial++}` });
}
function context() {
	return { modelRegistry: runtime, cwd, model };
}
function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function code(promise: Promise<unknown>, expected: DelegationErrorCode) {
	await expect(promise).rejects.toBeInstanceOf(DelegationError);
	await expect(promise).rejects.toHaveProperty("code", expected);
}
async function isolatedRuntime(): Promise<ModelRegistry> {
	return (await createFauxModelRegistry(Settings.isolated({}))).modelRegistry;
}
function register(target: ModelRegistry, overrides: { apiKey?: string } = {}) {
	target.registerProvider(model.provider, faux.providerConfig(overrides));
}

beforeAll(async () => {
	priorOffline = process.env.PI_OFFLINE;
	agentDir = isolateAgentDir(join(root, "agent"));
	process.env.PI_OFFLINE = "1";
	runtime = await isolatedRuntime();
	register(runtime);
});
afterAll(() => {
	agentDir?.restore();
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
	rmSync(root, { recursive: true, force: true });
});

test("resource-only zero-worker retention, duplicate admission, validation and release", async () => {
	const core = service();
	let loaded = 0;
	const resource = await core.registerResource("graph", context(), {
		childExtensionFactories: [
			() => {
				loaded++;
			},
		],
	});
	expect(loaded).toBe(0);
	const requestedModel = { ...model };
	const validating = resource.validateModels([requestedModel]);
	requestedModel.id = "mutated-after-admission";
	await validating;
	await code(
		resource.validateModels([{ provider: "missing", id: "missing" }]),
		"model-unavailable",
	);
	await code(core.registerResource("graph", context()), "resource-exists");
	await code(core.createChild({ ...spec, parent: "missing" }), "unknown-parent");
	await resource.release();
	await resource.release();
	await code(resource.createChild(spec), "disposed");
	const replacement = await core.registerResource("graph", context());
	await replacement.release();
	expect(runtime.find(model.provider, model.id)).toBeDefined();
});

test("resource child admission snapshots create and reopen inputs before awaiting", async () => {
	const core = service();
	const owner = await core.registerResource("snapshots", context());
	const mutable = {
		visibility: "hidden" as const,
		info: { createdBy: "admitted" },
		session: {
			...sessionOptions,
			model: { ...model },
			tools: [] as string[],
		},
	};
	const creating = owner.createChild(mutable);
	mutable.info.createdBy = "mutated";
	mutable.session.model.id = "missing";
	mutable.session.systemPrompt = "MUTATED_CREATE";
	mutable.session.tools.push("late-tool");
	const child = await creating;
	expect(child.record.info.createdBy).toBe("admitted");
	faux.setResponses([fauxAssistantMessage("CREATED")]);
	expect((await child.runQueued("first")).finalText).toBe("CREATED");
	const { sessionFile, ...birth } = child.record;
	await child.dispose();
	const restore = {
		...sessionOptions,
		model: { ...model },
		tools: [] as string[],
	};
	const reopening = owner.reopenChild({ birth, session: restore });
	restore.model.id = "missing";
	restore.systemPrompt = "MUTATED_REOPEN";
	restore.tools.push("late-tool");
	const reopened = await reopening;
	faux.setResponses([fauxAssistantMessage("REOPENED")]);
	expect((await reopened.runQueued("second")).finalText).toBe("REOPENED");
	const stored = readFileSync(sessionFile, "utf8");
	expect(stored).not.toContain("MUTATED_CREATE");
	expect(stored).not.toContain("MUTATED_REOPEN");
	expect(stored).not.toContain("late-tool");
	await owner.release();
});

test("retains the borrowed registry after source chat disposal, isolated from parent APIs", async () => {
	const core = service();
	const selected = runtime.find(model.provider, model.id);
	if (!selected) throw new Error("Missing synthetic model");
	const source = await createAgentSession({
		cwd,
		agentDir: join(root, "agent"),
		settings: Settings.isolated({}),
		modelRegistry: runtime,
		sessionManager: SessionManager.inMemory(cwd),
		model: selected,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	const resource = await core.registerResource("retained", context());
	await source.session.dispose();
	const events: unknown[] = [];
	core.onLifecycle((event) => events.push(event));
	const child = await resource.createChild(spec);
	expect(core.findChild(child.sessionId)).toBeUndefined();
	expect(core.childrenOf("retained")).toEqual([]);
	expect("parentSessionId" in child.record).toBe(false);
	expect(Object.isFrozen(child.record)).toBe(true);
	expect(Object.isFrozen(child.record.info)).toBe(true);
	await core.disposeChildrenOf("retained");
	faux.setResponses([fauxAssistantMessage("RETAINED")]);
	const outcome = await child.runQueued("run");
	expect(outcome.finalText).toBe("RETAINED");
	expect(outcome.stopReason).toBe("stop");
	expect(outcome.historyEntryId).not.toBeNull();
	expect(events).toEqual([]);
	await resource.release();
});

test("registry borrowing is live: a provider later removed from the source fails explicitly, never by substitution", async () => {
	const sourceRuntime = await isolatedRuntime();
	register(sourceRuntime);
	const core = service();
	const resource = await core.registerResource("registry", {
		modelRegistry: sourceRuntime,
		cwd,
		model,
	});
	await resource.validateModels([model]);
	faux.setResponses([fauxAssistantMessage("SHARED_REGISTRY")]);
	const child = await resource.createChild(spec);
	expect((await child.runQueued("run")).finalText).toBe("SHARED_REGISTRY");
	sourceRuntime.unregisterProvider(model.provider);
	await code(resource.validateModels([model]), "model-unavailable");
	await code(resource.createChild(spec), "model-unavailable");
	await resource.release();
});

test("runtime-only credentials held by the borrowed registry serve resource children", async () => {
	const sourceRuntime = await isolatedRuntime();
	register(sourceRuntime);
	sourceRuntime.authStorage.keys.setRuntime(model.provider, "runtime-only");
	const core = service();
	const resource = await core.registerResource("runtime-credentials", {
		modelRegistry: sourceRuntime,
		cwd,
		model,
	});
	await resource.validateModels([model]);
	let requestKey: string | undefined;
	faux.setResponses([
		(_context, options) => {
			requestKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
			return fauxAssistantMessage("RUNTIME_KEY");
		},
	]);
	const child = await resource.createChild(spec);
	expect((await child.runQueued("run")).finalText).toBe("RUNTIME_KEY");
	expect(requestKey).toBe("runtime-only");
	await resource.release();
});

test("capture fork fan-out is source-independent and persists independent effective model/thinking metadata", async () => {
	const core = service();
	const owner = await core.registerResource("forks", context());
	const source = await owner.createChild(spec);
	faux.setResponses([fauxAssistantMessage("SAVED"), fauxAssistantMessage("NEWER")]);
	const first = await source.runQueued("original");
	await source.runQueued("later");
	const history = await core.captureHistory({
		kind: "resource-child",
		resourceId: "forks",
		sessionId: source.sessionId,
		entryId: first.historyEntryId,
	});
	expect(history.jsonl).toContain("SAVED");
	expect(history.jsonl).not.toContain("NEWER");
	await source.dispose();
	rmSync(source.record.sessionFile);
	const sourceManager = SessionManager.inMemory(cwd);
	sourceManager.appendModelChange("old/old");
	sourceManager.appendThinkingLevelChange("xhigh");
	const sourceCut = sourceManager.appendMessage({
		role: "user",
		content: "prior",
		timestamp: Date.now(),
	});
	const configuredHistory = await core.captureHistory({
		kind: "session",
		sessionId: sourceManager.getSessionId(),
		sessionManager: sourceManager,
		cut: { kind: "at-entry", entryId: sourceCut },
	});
	for (const seed of [history, history, configuredHistory]) {
		const child = await owner.createChild({
			...spec,
			origin: { kind: "fork-captured", history: seed },
		});
		expect(child.record.originKind).toBe("fork");
		expect(child.record.entryId).toBe(seed.entryId ?? undefined);
		const manager = await SessionManager.open(child.record.sessionFile);
		expect(manager.buildSessionContext().models.default).toBe(`${model.provider}/${model.id}`);
		expect(manager.buildSessionContext().thinkingLevel).toBe("off");
		const seedFile = manager.getHeader()?.parentSession;
		expect(seedFile).toBeDefined();
		expect(existsSync(seedFile ?? "")).toBe(false);
		faux.setResponses([fauxAssistantMessage("FORKED")]);
		expect((await child.runQueued("continue")).finalText).toBe("FORKED");
		await child.dispose();
	}
	await owner.release();
});

test("captured forks keep Anthropic-bound thinking verbatim; omp replay drops foreign signatures for a signing target", async () => {
	const core = service();
	const source = SessionManager.inMemory(cwd);
	source.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
	const signed: AssistantMessage = {
		...fauxAssistantMessage("unused"),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [
			{ type: "thinking", thinking: "bound", thinkingSignature: "signed-anthropic" },
			{ type: "redactedThinking", data: "encrypted" },
			{ type: "thinking", thinking: "portable" },
			{ type: "text", text: "answer" },
		],
	};
	source.appendMessage(signed);
	source.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
	source.appendMessage({
		...fauxAssistantMessage("unused"),
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		content: [
			{ type: "thinking", thinking: "other provider", thinkingSignature: "signed-openai" },
			{ type: "text", text: "second answer" },
		],
	});
	const history = await core.captureHistory({
		kind: "session",
		sessionId: source.getSessionId(),
		sessionManager: source,
		cut: { kind: "at-entry", entryId: source.getLeafId() },
	});
	const owner = await core.registerResource("signed-thinking", context());
	const child = await owner.createChild({
		...spec,
		origin: { kind: "fork-captured", history },
	});
	const stored = readFileSync(child.record.sessionFile, "utf8");
	expect(stored).toContain("signed-anthropic");
	expect(stored).toContain("encrypted");
	const manager = await SessionManager.open(child.record.sessionFile);
	const replay = manager
		.buildSessionContext()
		.messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
	expect(JSON.stringify(replay)).toContain("signed-anthropic");
	const official = runtime.find("anthropic", "claude-opus-5-5");
	const otherDeployment = runtime.find("github-copilot", "claude-opus-5.5");
	if (!official || !otherDeployment) throw new Error("Missing bundled Anthropic catalog models");
	expect(official.thinking?.prefixBinding).toBe(true);
	const anthropicReplay = JSON.stringify(transformMessages(replay, otherDeployment));
	expect(anthropicReplay).not.toContain("signed-anthropic");
	expect(anthropicReplay).not.toContain("encrypted");
	expect(anthropicReplay).toContain("portable");
	faux.setResponses([fauxAssistantMessage("SAFE_FORK")]);
	expect((await child.runQueued("continue safely")).finalText).toBe("SAFE_FORK");
	await owner.release();
});

test("faithful reopen retains birth authority, reloads factories at current cwd and clamps max thinking without the source", async () => {
	const core = service();
	const startedCwds: string[] = [];
	const factory: ExtensionFactory = (pi) => {
		pi.on("session_start", (_event, ctx) => {
			startedCwds.push(ctx.cwd);
		});
	};
	let resource = await core.registerResource("restore", context(), {
		childExtensionFactories: [factory],
	});
	const options = { ...sessionOptions, extensions: true, thinkingLevel: "max" as const };
	const child = await resource.createChild({ ...spec, session: options });
	faux.setResponses([fauxAssistantMessage("FIRST")]);
	const outcome = await child.runQueued("run");
	expect(outcome.status).toBe("completed");
	const { sessionFile, ...birth } = child.record;
	expect((await SessionManager.open(sessionFile)).buildSessionContext().thinkingLevel).toBe("off");
	await code(resource.reopenChild({ birth, session: options }), "invalid-child-record");
	await resource.release();
	const before = readFileSync(sessionFile, "utf8");
	const offline = createDelegationService({ delegationRoot: root, scope: birth.scope });
	const captured = await offline.captureHistory({
		kind: "resource-child",
		resourceId: "restore",
		sessionId: birth.sessionId,
		entryId: outcome.historyEntryId,
	});
	expect(captured.jsonl).toContain("FIRST");
	expect(readFileSync(sessionFile, "utf8")).toBe(before);
	const restoredCwd = join(root, "restored-cwd");
	mkdirSync(restoredCwd, { recursive: true });
	resource = await offline.registerResource(
		"restore",
		{ ...context(), cwd: restoredCwd },
		{
			childExtensionFactories: [factory],
		},
	);
	const authoritative: ResourceChildBirth = {
		...birth,
		originKind: "fork",
		entryId: "saved-cut",
		createdAt: "2020-01-02T03:04:05.000Z",
		info: { createdBy: "saved:owner", roleName: "saved" },
	};
	const reopened = await resource.reopenChild({ birth: authoritative, session: options });
	expect(reopened.record).toEqual({ ...authoritative, sessionFile });
	expect(startedCwds).toEqual([cwd, restoredCwd]);
	faux.setResponses([fauxAssistantMessage("SECOND")]);
	expect(await reopened.runQueued("resume")).toMatchObject({
		status: "completed",
		finalText: "SECOND",
	});
	expect((await SessionManager.open(sessionFile)).buildSessionContext().thinkingLevel).toBe("off");
	await resource.release();
});

test("reopen of a crash-dangling tool batch replays without the unpaired call", async () => {
	const core = service();
	let owner = await core.registerResource("repair", context());
	const child = await owner.createChild(spec);
	faux.setResponses([fauxAssistantMessage("BEFORE_CRASH")]);
	await child.runQueued("persist a transcript");
	const { sessionFile, ...birth } = child.record;
	await child.dispose();
	const dangling = await SessionManager.open(sessionFile);
	dangling.appendMessage(fauxAssistantMessage(fauxToolCall("dag_submit_result", { outputs: {} })));
	await dangling.flush();
	expect(readFileSync(sessionFile, "utf8")).toContain("dag_submit_result");
	await owner.release();
	owner = await core.registerResource("repair", context());
	const reopened = await owner.reopenChild({ birth, session: sessionOptions });
	const replay = (await SessionManager.open(sessionFile)).buildSessionContext().messages;
	expect(scanReplayTools(replay)).toEqual({ issues: [], danglingTail: [] });
	expect(JSON.stringify(replay)).not.toContain("dag_submit_result");
	faux.setResponses([
		(providerContext) => {
			expect(JSON.stringify(providerContext.messages)).not.toContain("dag_submit_result");
			return fauxAssistantMessage("AFTER_REPAIR");
		},
	]);
	expect((await reopened.runQueued("continue")).finalText).toBe("AFTER_REPAIR");
	await owner.release();
});

test("reopen rejects a malformed replay omp cannot heal, while a non-tail unpaired call heals", async () => {
	const core = service();
	let owner = await core.registerResource("replay-gap", context());
	const child = await owner.createChild(spec);
	faux.setResponses([fauxAssistantMessage("STORED")]);
	await child.runQueued("persist");
	const { sessionFile, ...birth } = child.record;
	await child.dispose();
	const manager = await SessionManager.open(sessionFile);
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "missing" })));
	manager.appendMessage({ role: "user", content: "later message", timestamp: Date.now() });
	await manager.flush();
	await owner.release();
	owner = await core.registerResource("replay-gap", context());
	const healed = await owner.reopenChild({ birth, session: sessionOptions });
	await healed.dispose();
	const orphaned = await SessionManager.open(sessionFile);
	orphaned.appendMessage({
		role: "toolResult",
		toolCallId: "never-called",
		toolName: "read",
		content: [{ type: "text", text: "orphan" }],
		isError: false,
		timestamp: Date.now(),
	});
	await orphaned.flush();
	await code(owner.reopenChild({ birth, session: sessionOptions }), "invalid-child-transcript");
	await owner.release();
});

test("strict resource lookup fails closed for missing, cross-owner, corrupt, ambiguous and linked transcripts", async () => {
	const core = service();
	const owner = await core.registerResource("lookup", context());
	const fresh = await owner.createChild(spec);
	const { sessionFile: missingFile, ...missingBirth } = fresh.record;
	await fresh.dispose();
	await code(
		owner.reopenChild({ birth: missingBirth, session: sessionOptions }),
		"child-transcript-unavailable",
	);
	expect(existsSync(missingFile)).toBe(false);
	const child = await owner.createChild(spec);
	faux.setResponses([fauxAssistantMessage("STORED")]);
	const outcome = await child.runQueued("run");
	const { sessionFile, ...birth } = child.record;
	await child.dispose();
	await code(
		owner.reopenChild({ birth: { ...birth, resourceId: "other" }, session: sessionOptions }),
		"invalid-child-record",
	);
	await code(
		owner.reopenChild({ birth: { ...birth, scope: "other" }, session: sessionOptions }),
		"invalid-child-record",
	);
	await code(
		core.captureHistory({
			kind: "resource-child",
			resourceId: "../lookup",
			sessionId: birth.sessionId,
			entryId: null,
		}),
		"invalid-history",
	);
	const duplicate = join(dirname(sessionFile), `duplicate_${birth.sessionId}.jsonl`);
	copyFileSync(sessionFile, duplicate);
	await code(owner.reopenChild({ birth, session: sessionOptions }), "invalid-child-transcript");
	rmSync(duplicate);
	const original = readFileSync(sessionFile, "utf8");
	writeFileSync(sessionFile, original.replace(birth.sessionId, "wrong-identity"));
	await code(owner.reopenChild({ birth, session: sessionOptions }), "invalid-child-transcript");
	await code(
		core.captureHistory({
			kind: "resource-child",
			resourceId: "lookup",
			sessionId: birth.sessionId,
			entryId: outcome.historyEntryId,
		}),
		"invalid-history",
	);
	writeFileSync(sessionFile, original);
	const target = join(root, `target-${basename(sessionFile)}`);
	copyFileSync(sessionFile, target);
	rmSync(sessionFile);
	symlinkSync(target, sessionFile);
	await code(owner.reopenChild({ birth, session: sessionOptions }), "invalid-child-transcript");
	await owner.release();
});

test("resource prompts and active steering are literal; idle/preflight steering cannot queue a later turn", async () => {
	const core = service();
	const entered = gate();
	const resume = gate();
	let commands = 0;
	const inputs: Array<{ text: string; source: string }> = [];
	const resource = await core.registerResource("literal", context(), {
		childExtensionFactories: [
			(pi) => {
				pi.registerCommand("literal", {
					description: "must not execute",
					handler: async () => {
						commands++;
					},
				});
				pi.on("input", (event) => {
					inputs.push({ text: event.text, source: event.source });
				});
				pi.on("message_end", async (event) => {
					if (event.message.role === "assistant" && !enteredDone) {
						enteredDone = true;
						entered.resolve();
						await resume.promise;
					}
				});
			},
		],
	});
	let enteredDone = false;
	const child = await resource.createChild(extensionSpec);
	await code(child.steer("idle"), "not-running");
	faux.setResponses([fauxAssistantMessage("FIRST"), fauxAssistantMessage("STEERED")]);
	const running = child.runQueued("/literal task");
	await entered.promise;
	await child.steer("/literal unchanged");
	resume.resolve();
	const result = await running;
	expect(result.finalText).toBe("STEERED");
	expect(commands).toBe(0);
	expect(inputs).toEqual([{ text: "/literal task", source: "extension" }]);
	const content = readFileSync(child.record.sessionFile, "utf8");
	expect(content).toContain("/literal task");
	expect(content).toContain("/literal unchanged");
	await code(child.steer("after"), "not-running");
	await resource.release();
});

test("abort covers asynchronous preflight and queued work, settles before successor admission", async () => {
	const core = service();
	const entered = gate();
	const resume = gate();
	const owner = await core.registerResource("cancel", context(), {
		maxConcurrent: 1,
		childExtensionFactories: [
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text === "held") {
						entered.resolve();
						await resume.promise;
					}
				});
			},
		],
	});
	const first = await owner.createChild(extensionSpec);
	const second = await owner.createChild(spec);
	faux.setResponses([fauxAssistantMessage("NEXT_ONLY")]);
	const running = first.runQueued("held");
	await entered.promise;
	await code(first.steer("preflight"), "not-running");
	await code(
		core.captureHistory({
			kind: "resource-child",
			resourceId: "cancel",
			sessionId: first.sessionId,
			entryId: null,
		}),
		"source-busy",
	);
	const queued = second.runQueued("queued");
	await second.abort();
	expect((await queued).stopReason).toBeUndefined();
	expect((await queued).status).toBe("aborted");
	let aborted = false;
	const aborting = first.abort().then(() => {
		aborted = true;
	});
	await Promise.resolve();
	expect(aborted).toBe(false);
	await code(first.runQueued("too early"), "already-running");
	resume.resolve();
	await aborting;
	const cancelled = await running;
	expect(cancelled.status).toBe("aborted");
	expect(cancelled.stopReason).toBeUndefined();
	expect(cancelled.finalText).toBeUndefined();
	expect(faux.getPendingResponseCount()).toBe(1);
	expect((await first.runQueued("next")).finalText).toBe("NEXT_ONLY");
	await owner.release();
});

test("release closes pending assembly, awaits child extension shutdown, then permits registration reuse", async () => {
	const core = service();
	const assembling = gate();
	const assemble = gate();
	const shuttingDown = gate();
	const shutdown = gate();
	const resource = await core.registerResource("release", context(), {
		childExtensionFactories: [
			async (pi) => {
				assembling.resolve();
				await assemble.promise;
				pi.on("session_shutdown", async () => {
					shuttingDown.resolve();
					await shutdown.promise;
				});
			},
		],
	});
	const creating = resource.createChild(extensionSpec);
	await assembling.promise;
	let released = false;
	const releasing = resource.release().then(() => {
		released = true;
	});
	await code(core.registerResource("release", context()), "resource-exists");
	assemble.resolve();
	await shuttingDown.promise;
	expect(released).toBe(false);
	shutdown.resolve();
	await code(creating, "disposed");
	await releasing;
	const replacement = await core.registerResource("release", context());
	await replacement.release();
});

test("resource-local pacing and factories do not contaminate other resource owners", async () => {
	const core = service();
	const entered = gate();
	const resume = gate();
	let localLoads = 0;
	const first = await core.registerResource("one", context(), {
		maxConcurrent: 1,
		childExtensionFactories: [
			(pi) => {
				localLoads++;
				pi.on("input", async (event) => {
					if (event.text === "held") {
						entered.resolve();
						await resume.promise;
					}
				});
			},
		],
	});
	const second = await core.registerResource("two", context(), { maxConcurrent: 1 });
	const a = await first.createChild(extensionSpec);
	const b = await first.createChild(spec);
	const c = await second.createChild(extensionSpec);
	expect(localLoads).toBe(1);
	faux.setResponses([
		fauxAssistantMessage("OTHER_OWNER"),
		fauxAssistantMessage("FIRST"),
		fauxAssistantMessage("FIFO"),
	]);
	const running = a.runQueued("held");
	await entered.promise;
	let started = false;
	const queued = b.runQueued("queued", {
		onUpdate: (details) => {
			if (details.status === "running") started = true;
		},
	});
	expect((await c.runQueued("independent")).finalText).toBe("OTHER_OWNER");
	expect(started).toBe(false);
	resume.resolve();
	expect((await running).finalText).toBe("FIRST");
	expect((await queued).finalText).toBe("FIFO");
	await first.release();
	await second.release();
});

test("a successful terminal tool ends the invocation before another provider call; a failed one does not", async () => {
	const core = service();
	const resource = await core.registerResource("terminal", context(), {
		terminalTools: ["finish"],
		childExtensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "finish",
					label: "Finish",
					description: "Finish the invocation",
					parameters: {
						type: "object",
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
						additionalProperties: false,
					},
					loadMode: "essential",
					async execute(_id, params: unknown) {
						if (typeof params !== "object" || params === null || !("ok" in params) || !params.ok)
							throw new Error("not finished");
						return { content: [{ type: "text", text: "done" }], details: undefined };
					},
				});
			},
		],
	});
	const child = await resource.createChild({
		...extensionSpec,
		session: { ...extensionSpec.session, tools: ["finish"] },
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("finish", { ok: true })),
		fauxAssistantMessage("AFTER_TERMINAL"),
	]);
	const calls = faux.state.callCount;
	const finished = await child.runQueued("finish now");
	expect(finished.status).toBe("completed");
	expect(finished.finalText ?? "").not.toContain("AFTER_TERMINAL");
	expect(faux.state.callCount).toBe(calls + 1);
	expect(faux.getPendingResponseCount()).toBe(1);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("finish", { ok: false })),
		fauxAssistantMessage("RECOVERED"),
	]);
	const recovered = await child.runQueued("fail first");
	expect(recovered.status).toBe("completed");
	expect(recovered.finalText).toBe("RECOVERED");
	expect(faux.getPendingResponseCount()).toBe(0);
	await resource.release();
});

test("finalized invocation evidence survives a shrinking compaction context and usage stays a pi-stat delta", async () => {
	const compactCwd = join(root, "compaction-cwd");
	mkdirSync(join(compactCwd, ".omp"), { recursive: true });
	writeFileSync(
		join(compactCwd, ".omp", "config.yml"),
		"compaction:\n  enabled: true\n  reserveTokens: 99999\n  keepRecentTokens: 1\n",
	);
	const core = service();
	const source = SessionManager.inMemory(compactCwd);
	for (let index = 0; index < 20; index++)
		source.appendMessage({ role: "user", content: `History ${index}`, timestamp: Date.now() });
	const history = await core.captureHistory({
		kind: "session",
		sessionId: source.getSessionId(),
		sessionManager: source,
		cut: { kind: "at-entry", entryId: source.getLeafId() },
	});
	let compacted = 0;
	const owner = await core.registerResource(
		"compaction",
		{ ...context(), cwd: compactCwd },
		{
			childExtensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						const last = event.branchEntries.at(-1);
						if (!last) throw new Error("Missing compaction cut");
						if (last.type !== "message" || last.message.role !== "assistant")
							return { cancel: true };
						return {
							compaction: {
								summary: "locally compacted",
								firstKeptEntryId: last.id,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
					pi.on("session_compact", () => {
						compacted++;
					});
				},
			],
		},
	);
	const child = await owner.createChild({
		...extensionSpec,
		origin: { kind: "fork-captured", history },
	});
	faux.setResponses([fauxAssistantMessage("AFTER_COMPACTION")]);
	const outcome = await child.runQueued("complete");
	expect(compacted).toBe(1);
	expect(outcome.finalText).toBe("AFTER_COMPACTION");
	expect(outcome.stopReason).toBe("stop");
	const manager = await SessionManager.open(child.record.sessionFile);
	expect(manager.buildSessionContext().messages.length).toBeLessThan(20);
	expect(manager.getLeafId()).toBe(outcome.historyEntryId);
	expect(manager.getLeafEntry()?.type).toBe("compaction");
	const assistant = manager
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (assistant?.type !== "message" || assistant.message.role !== "assistant")
		throw new Error("Missing assistant");
	expect(outcome.details.usage.input).toBe(assistant.message.usage.input);
	expect(outcome.details.usage.output).toBe(assistant.message.usage.output);
	await owner.release();
});

test("late steering is cleared at settlement and cancellation never rewrites finalized stop evidence", async () => {
	const core = service();
	const ended = gate();
	const settle = gate();
	let firstEnd = true;
	const owner = await core.registerResource("late-control", context(), {
		childExtensionFactories: [
			(pi) => {
				pi.on("agent_end", async () => {
					if (firstEnd) {
						firstEnd = false;
						ended.resolve();
						await settle.promise;
					}
				});
			},
		],
	});
	const child = await owner.createChild(extensionSpec);
	faux.setResponses([fauxAssistantMessage("FINALIZED")]);
	const running = child.runQueued("first");
	await ended.promise;
	await child.steer("MUST_NOT_LEAK");
	const aborting = child.abort();
	settle.resolve();
	const outcome = await running;
	await aborting;
	expect(outcome.stopReason).toBe("stop");
	expect(outcome.finalText).toBe("FINALIZED");
	faux.setResponses([
		(providerContext) => {
			expect(JSON.stringify(providerContext.messages)).not.toContain("MUST_NOT_LEAK");
			return fauxAssistantMessage("NEXT");
		},
	]);
	expect((await child.runQueued("successor")).finalText).toBe("NEXT");
	await owner.release();
});

test("release synchronously cancels every running/queued child and awaits their shutdown before reuse", async () => {
	const core = service();
	const input = gate();
	const finishInput = gate();
	let shutdowns = 0;
	const owner = await core.registerResource("all-children", context(), {
		maxConcurrent: 1,
		childExtensionFactories: [
			(pi) => {
				pi.on("input", async () => {
					input.resolve();
					await finishInput.promise;
				});
				pi.on("session_shutdown", () => {
					shutdowns++;
				});
			},
		],
	});
	const a = await owner.createChild(extensionSpec);
	const b = await owner.createChild(extensionSpec);
	faux.setResponses([fauxAssistantMessage("NEVER_REQUESTED")]);
	const running = a.runQueued("running");
	await input.promise;
	const queued = b.runQueued("queued");
	const releasing = owner.release();
	expect((await queued).status).toBe("aborted");
	await code(a.steer("too late"), "disposed");
	await code(owner.createChild(spec), "disposed");
	finishInput.resolve();
	await releasing;
	expect((await running).status).toBe("aborted");
	expect(shutdowns).toBe(2);
	expect(faux.getPendingResponseCount()).toBe(1);
});

test("fork admission revalidates canonical bytes, identity, boundary, digest and tool closure; empty forks work", async () => {
	const core = service();
	const owner = await core.registerResource("validate-capture", context());
	const fork = (history: CapturedHistory) =>
		owner.createChild({ ...spec, origin: { kind: "fork-captured", history } });
	const manager = SessionManager.inMemory(cwd);
	const first = manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
	const history = await core.captureHistory({
		kind: "session",
		sessionId: manager.getSessionId(),
		sessionManager: manager,
		cut: { kind: "at-entry", entryId: manager.getLeafId() },
	});
	for (const invalid of [
		{ ...history, entryId: first },
		{ ...history, entryId: null },
		{ ...history, sha256: "wrong" },
		{ ...history, sizeBytes: history.sizeBytes + 1 },
	]) {
		await code(fork(invalid), "invalid-history");
	}
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "never-called",
		toolName: "read",
		content: [{ type: "text", text: "orphan" }],
		isError: false,
		timestamp: Date.now(),
	});
	const header = JSON.stringify(manager.getHeader());
	for (const [jsonl, entryId, expected] of [
		[history.jsonl.slice(0, -1), history.entryId, "invalid-history"],
		["not-json\n", history.entryId, "invalid-history"],
		[`${header}\n${history.jsonl}`, history.entryId, "invalid-history"],
		[history.jsonl.slice(header.length + 1), history.entryId, "invalid-history"],
		[history.jsonl.replace(history.sourceSessionId, "foreign"), history.entryId, "invalid-history"],
		[
			`${history.jsonl}${JSON.stringify(manager.getLeafEntry())}\n`,
			manager.getLeafId(),
			"incomplete-history",
		],
	] as const) {
		await code(
			fork({
				...history,
				jsonl,
				entryId,
				sha256: createHash("sha256").update(jsonl).digest("hex"),
				sizeBytes: Buffer.byteLength(jsonl),
			}),
			expected,
		);
	}
	const empty = await core.captureHistory({
		kind: "session",
		sessionId: manager.getSessionId(),
		sessionManager: manager,
		cut: { kind: "at-entry", entryId: null },
	});
	const child = await fork(empty);
	expect(child.record.originKind).toBe("fork");
	expect("entryId" in child.record).toBe(false);
	await owner.release();
});

test("extension-registered providers on the borrowed registry serve children without a provider ban or pruning", async () => {
	const native = fauxProvider({
		provider: "native-local",
		api: "native-local",
		models: [{ id: model.id, reasoning: false, input: ["text"] }],
	});
	const sourceRuntime = await isolatedRuntime();
	sourceRuntime.registerProvider(native.provider.id, native.provider.config, "<inline-0>");
	const reference = { provider: native.provider.id, id: model.id };
	const core = service();
	const resource = await core.registerResource(
		"native",
		{ modelRegistry: sourceRuntime, cwd, model: reference },
		{ childExtensionFactories: [() => {}] },
	);
	await resource.validateModels([reference]);
	const child = await resource.createChild({
		...spec,
		session: { ...sessionOptions, model: reference, extensions: true },
	});
	expect(sourceRuntime.find(reference.provider, reference.id)).toBeDefined();
	native.setResponses([fauxAssistantMessage("NATIVE_REPLAY")]);
	expect((await child.runQueued("later native")).finalText).toBe("NATIVE_REPLAY");
	await resource.release();
});
