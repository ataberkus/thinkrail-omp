import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	type ModelRegistry,
	type ProviderConfigInput,
	SessionManager,
	Settings,
	type TurnEndEvent,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createDelegationService, type DelegationService } from "pi-delegation";
import {
	createFauxCore,
	createFauxModelRegistry,
	fauxAssistantMessage,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
} from "pi-faux";
import defaultSubagents, {
	createSubagents,
	createSubagentsExtension,
	SUBAGENT_COMPLETION_MESSAGE,
} from "../index";
import { boundedText } from "./extension";

function fauxCore(provider: string) {
	return createFauxCore({
		provider,
		api: provider,
		models: [
			{
				id: provider,
				name: provider,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
		tokensPerSecond: 4000,
	});
}

const fauxA = fauxCore("fauxa");
const fauxB = fauxCore("fauxb");
const fauxReasoner = fauxCore("fauxreasoner");

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

let isolatedAgentDir: IsolatedAgentDir | undefined;
let priorOffline: string | undefined;
let runtime: ModelRegistry;
let agentDir: string;
let parent: AgentSession;
let parentCwd: string;
let service: DelegationService;
let bgRunnerPath: string;
const liveParents = new Map<string, AgentSession>();

const BG_RUNNER_DEFINITION =
	"---\nname: bg-runner\ndescription: Background test runner\nmodel: fauxb\n---\n\nRun the delegated task.\n";

function fauxConfig(core: typeof fauxA, id: string, reasoning = false): ProviderConfigInput {
	return {
		api: core.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: core.streamSimple,
		models: [
			{
				id,
				name: id,
				api: core.api,
				reasoning,
				...(reasoning
					? {
							thinking: {
								mode: "effort" as const,
								efforts: [
									ThinkingLevel.Minimal,
									ThinkingLevel.Low,
									ThinkingLevel.Medium,
									ThinkingLevel.High,
									ThinkingLevel.XHigh,
									ThinkingLevel.Max,
								],
							},
						}
					: {}),
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
	};
}

function registerFaux(core: typeof fauxA, id: string): void {
	runtime.registerProvider(id, fauxConfig(core, id));
}

function withSendMessage(pi: ExtensionAPI, sendMessage: ExtensionAPI["sendMessage"]): ExtensionAPI {
	return new Proxy(pi, {
		get: (target, property) =>
			property === "sendMessage" ? sendMessage : Reflect.get(target, property, target),
	});
}

function fauxModel() {
	const model = runtime.find("fauxa", "fauxa");
	if (!model) throw new Error("fauxa not registered");
	return model;
}

async function bindSession(
	factory: ExtensionFactory,
	sessionManager: SessionManager = SessionManager.inMemory(parentCwd),
): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: parentCwd,
		agentDir,
		settings: Settings.isolated({}),
		modelRegistry: runtime,
		model: fauxModel(),
		sessionManager,
		extensions: [factory],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
		bindProcessState: false,
	});
	liveParents.set(session.sessionId, session);
	try {
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: (error) => {
				throw new Error(error.error);
			},
		});
		return session;
	} catch (error) {
		liveParents.delete(session.sessionId);
		await session.dispose();
		throw error;
	}
}

function toolInfo(session: AgentSession, name: string) {
	return session.getAllToolInfos().find((tool) => tool.name === name);
}

beforeAll(async () => {
	agentDir = tmpDir("pi-subagents-agentdir-");
	isolatedAgentDir = isolateAgentDir(agentDir);
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";

	mkdirSync(join(agentDir, "agents"), { recursive: true });
	bgRunnerPath = join(agentDir, "agents", "bg-runner.md");
	writeFileSync(bgRunnerPath, BG_RUNNER_DEFINITION);
	writeFileSync(
		join(agentDir, "agents", "capped.md"),
		"---\nname: capped\ndescription: Turn-capped test agent\ntools: read, ls\nmax_turns: 1\n---\n\nWork until stopped.\n",
	);
	writeFileSync(
		join(agentDir, "agents", "extension-provider.md"),
		"---\nname: extension-provider\ndescription: Extension-provider test agent\nmodel: extension-faux\n---\n\nRun through the extension-registered provider.\n",
	);

	runtime = (await createFauxModelRegistry(Settings.isolated({}))).modelRegistry;
	registerFaux(fauxA, "fauxa");
	registerFaux(fauxB, "fauxb");
	runtime.registerProvider("fauxreasoner", fauxConfig(fauxReasoner, "fauxreasoner", true));

	parentCwd = tmpDir("pi-subagents-parent-");

	service = createDelegationService({
		resolveParent: (id) => {
			const live = liveParents.get(id);
			return live
				? { cwd: parentCwd, model: live.model, thinkingLevel: live.thinkingLevel }
				: undefined;
		},
		delegationRoot: tmpDir("pi-subagents-delegation-"),
		scope: "ws-sub",
		modelRegistry: runtime,
	});

	parent = await bindSession(createSubagentsExtension({ service }));
});

beforeEach(async () => {
	if (parent) await service.disposeChildrenOf(parent.sessionId);
});

afterAll(async () => {
	await parent?.dispose();
	isolatedAgentDir?.restore();
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function storedChildContext(session: AgentSession = parent) {
	const child = service.childrenOf(session.sessionId)[0];
	if (!child) throw new Error("Expected a delegated child");
	return (await SessionManager.open(child.record.sessionFile)).buildSessionContext();
}

function transcript(): string {
	return JSON.stringify(parent.messages);
}

function lastToolResultText(session: AgentSession = parent): string {
	const message = session.messages.filter((m) => m.role === "toolResult").at(-1) as
		| { content: Array<{ type: string; text?: string }> }
		| undefined;
	return (message?.content ?? [])
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("\n");
}

async function makeSession(
	isEnabled?: () => boolean,
	boundService: DelegationService = service,
	factory?: ExtensionFactory,
	sessionManager?: SessionManager,
): Promise<AgentSession> {
	return bindSession(
		factory ??
			createSubagentsExtension({
				service: boundService,
				...(isEnabled ? { isEnabled } : {}),
			}),
		sessionManager,
	);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await Bun.sleep(20);
	}
}

test("an embedder can keep subagent tools registered but inactive at session start", async () => {
	const session = await makeSession(() => false);
	try {
		const configured = session.getAllToolNames();
		expect(configured).toContain("Agent");
		expect(configured).toContain("get_subagent_result");
		expect(session.getActiveToolNames()).not.toContain("Agent");
		expect(session.getActiveToolNames()).not.toContain("get_subagent_result");
	} finally {
		liveParents.delete(session.sessionId);
		await session.dispose();
	}
});

test("the live enabled predicate rejects a launch selected before embedder policy changed", async () => {
	let enabled = true;
	const session = await makeSession(() => enabled);
	try {
		enabled = false;
		fauxA.setResponses([
			fauxAssistantMessage(
				fauxToolCall("Agent", { subagent_type: "scout", task: "Should not start." }),
			),
			fauxAssistantMessage("PARENT_RECOVERED"),
		]);

		await session.prompt("Try to delegate.");

		expect(lastToolResultText(session)).toContain("Subagents are disabled");
		expect(service.childrenOf(session.sessionId)).toEqual([]);
	} finally {
		await service.disposeChildrenOf(session.sessionId);
		liveParents.delete(session.sessionId);
		await session.dispose();
	}
});

test("a disable during asynchronous child creation disposes it before provider work starts", async () => {
	let enabled = true;
	let releaseChild = () => {};
	const childGate = new Promise<void>((resolve) => {
		releaseChild = resolve;
	});
	let signalChildCreated = () => {};
	const childCreated = new Promise<void>((resolve) => {
		signalChildCreated = resolve;
	});
	const gatedService: DelegationService = {
		...service,
		async createChild(spec) {
			const child = await service.createChild(spec);
			signalChildCreated();
			await childGate;
			return child;
		},
	};
	const session = await makeSession(() => enabled, gatedService);
	const childCallsBefore = fauxB.state.callCount;
	try {
		fauxA.setResponses([
			fauxAssistantMessage(
				fauxToolCall("Agent", { subagent_type: "bg-runner", task: "Do not start." }),
			),
			fauxAssistantMessage("PARENT_RECOVERED"),
		]);
		fauxB.setResponses([fauxAssistantMessage("CHILD_SHOULD_NOT_RUN")]);
		const turn = session.prompt("Try to delegate during a policy change.");
		await childCreated;
		enabled = false;
		releaseChild();
		await turn;

		expect(lastToolResultText(session)).toContain("Subagents are disabled");
		expect(fauxB.state.callCount).toBe(childCallsBefore);
		expect(service.childrenOf(session.sessionId)).toEqual([]);
	} finally {
		releaseChild();
		await service.disposeChildrenOf(session.sessionId);
		liveParents.delete(session.sessionId);
		await session.dispose();
	}
});

test("foreground: one Agent call runs a builtin scout and returns its report to the parent", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", { subagent_type: "scout", task: "Map the auth module." }),
		),
		fauxAssistantMessage("SCOUT_REPORT"),
		fauxAssistantMessage("PARENT_SUMMARY"),
	]);

	await parent.prompt("Send a scout.");

	expect(transcript()).toContain("SCOUT_REPORT");
	const last = parent.messages.filter((m) => m.role === "assistant").at(-1);
	expect(JSON.stringify(last)).toContain("PARENT_SUMMARY");

	const children = service.childrenOf(parent.sessionId);
	expect(children.length).toBe(1);
	expect(children[0]?.record.info).toEqual({
		createdBy: "tool:Agent",
		roleName: "scout",
		roleSource: "builtin",
	});
	expect(children[0]?.snapshot?.status).toBe("completed");
	await service.disposeChildrenOf(parent.sessionId);
});

test("Agent advertises thinking suffix syntax without adding a separate thinking argument", () => {
	const tool = toolInfo(parent, "Agent");
	const parameters = tool?.parameters;
	const schema =
		parameters && "toJsonSchema" in parameters && typeof parameters.toJsonSchema === "function"
			? parameters.toJsonSchema()
			: parameters;
	expect(tool?.description).toContain(":<thinking>");
	expect(tool?.description).toContain("definition thinking overrides");
	expect(JSON.stringify(schema)).toContain("provider/id:thinking");
	expect(schema).not.toHaveProperty("properties.thinking");
});

test("a per-call model runs an unpinned agent on a different model than the parent", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "scout",
				task: "Use the requested model.",
				model: "fauxb/fauxb",
			}),
		),
		fauxAssistantMessage("PARENT_USED_CALL_MODEL"),
	]);
	fauxB.setResponses([fauxAssistantMessage("CALL_MODEL_CHILD_OK")]);

	await parent.prompt("Delegate on fauxb.");

	expect(transcript()).toContain("CALL_MODEL_CHILD_OK");
	expect(transcript()).toContain("PARENT_USED_CALL_MODEL");
	const child = service.childrenOf(parent.sessionId)[0];
	expect(child?.snapshot?.details.model).toBe("fauxb/fauxb");
	await service.disposeChildrenOf(parent.sessionId);
});

test.each([
	["fauxreasoner", "xhigh", false],
	["fauxreasoner", "xhigh", true],
	["fauxb", "off", false],
	["fauxb", "off", true],
] as const)("suffix thinking on %s becomes %s in the child, not the parent (background %s)", async (provider, expectedThinking, background) => {
	const originalModel = parent.model;
	const originalThinking = parent.thinkingLevel;
	const marker = `THINKING_${provider}_${background}`;
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "reviewer",
				task: "Report your findings.",
				model: `${provider}/${provider}:xhigh`,
				run_in_background: background,
			}),
		),
		fauxAssistantMessage(background ? `STARTED_${marker}` : `DONE_${marker}`),
		...(background ? [fauxAssistantMessage(`DONE_${marker}`)] : []),
	]);
	const core = provider === "fauxb" ? fauxB : fauxReasoner;
	core.setResponses([fauxAssistantMessage(`CHILD_${marker}`)]);

	await parent.prompt("Delegate with a thinking suffix.");
	await waitFor(() => transcript().includes(`DONE_${marker}`));
	await parent.waitForIdle();

	const context = await storedChildContext();
	expect(context.models.default).toBe(`${provider}/${provider}`);
	expect(context.thinkingLevel).toBe(expectedThinking);
	expect(transcript()).toContain(`CHILD_${marker}`);
	expect(parent.model).toEqual(originalModel);
	expect(parent.thinkingLevel).toBe(originalThinking);
});

test.each([
	false,
	true,
])("an unsuffixed child inherits live parent thinking (model selected %s)", async (selectModel) => {
	const session = await makeSession();
	try {
		const model = runtime.find("fauxreasoner", "fauxreasoner");
		if (!model) throw new Error("Reasoning model not registered");
		await session.setModel(model);
		session.setThinkingLevel(ThinkingLevel.High);
		fauxReasoner.setResponses([
			fauxAssistantMessage(
				fauxToolCall("Agent", {
					subagent_type: "reviewer",
					task: "Inherit thinking.",
					...(selectModel ? { model: "fauxreasoner/fauxreasoner" } : {}),
				}),
			),
			fauxAssistantMessage("INHERITED_THINKING"),
			fauxAssistantMessage("PARENT_DONE"),
		]);
		await session.prompt("Delegate without a suffix.");
		expect((await storedChildContext(session)).thinkingLevel).toBe("high");
		expect<string | undefined>(session.thinkingLevel).toBe("high");
	} finally {
		await service.disposeChildrenOf(session.sessionId);
		liveParents.delete(session.sessionId);
		await session.dispose();
	}
});

test.each([
	false,
	true,
])("invalid suffix selection is a tool error before child creation (background %s)", async (background) => {
	const callsBefore = fauxReasoner.state.callCount;
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "reviewer",
				task: "Never start.",
				model: "fauxreasoner/missing:xhigh",
				run_in_background: background,
			}),
		),
		fauxAssistantMessage("PARENT_RECOVERED_SELECTION"),
	]);
	await parent.prompt("Try an unavailable model with a suffix.");
	const result = parent.messages.filter((message) => message.role === "toolResult").at(-1);
	expect(result?.isError).toBe(true);
	expect(lastToolResultText()).toContain('base "fauxreasoner/missing"');
	expect(lastToolResultText()).toContain("not available in this session");
	expect(lastToolResultText()).not.toContain("qualify");
	expect(service.childrenOf(parent.sessionId)).toEqual([]);
	expect(fauxReasoner.state.callCount).toBe(callsBefore);
});

test("a definition-pinned model silently wins over the per-call model", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "bg-runner",
				task: "Keep the definition pin.",
				model: "unobtanium:turbo",
			}),
		),
		fauxAssistantMessage("PARENT_USED_PINNED_MODEL"),
	]);
	fauxB.setResponses([fauxAssistantMessage("PINNED_MODEL_CHILD_OK")]);

	await parent.prompt("Delegate with a redundant model.");

	expect(transcript()).toContain("PINNED_MODEL_CHILD_OK");
	expect(transcript()).toContain("PARENT_USED_PINNED_MODEL");
	expect((await storedChildContext()).thinkingLevel).toBe("off");
	const child = service.childrenOf(parent.sessionId)[0];
	expect(child?.snapshot?.details.model).toBe("fauxb/fauxb");
	await service.disposeChildrenOf(parent.sessionId);
});

test("a live definition edit refreshes advertised and effective model/thinking policy together", async () => {
	try {
		writeFileSync(
			bgRunnerPath,
			BG_RUNNER_DEFINITION.replace("model: fauxb", "model: fauxreasoner:xhigh\nthinking: low"),
		);
		fauxA.setResponses([
			fauxAssistantMessage(
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "Use the refreshed definition pin.",
					model: "unobtanium",
				}),
			),
			fauxAssistantMessage("PARENT_USED_REFRESHED_PIN"),
		]);
		fauxReasoner.setResponses([fauxAssistantMessage("REFRESHED_PIN_CHILD_OK")]);

		await parent.prompt("Delegate after the definition changes.");

		expect(transcript()).toContain("REFRESHED_PIN_CHILD_OK");
		expect(transcript()).toContain("PARENT_USED_REFRESHED_PIN");
		expect(toolInfo(parent, "Agent")?.description).toContain(
			"model: pinned fauxreasoner:xhigh; thinking: low (overrides suffix)",
		);
		const child = service.childrenOf(parent.sessionId)[0];
		expect(child?.snapshot?.details.model).toBe("fauxreasoner/fauxreasoner");
		expect((await storedChildContext()).thinkingLevel).toBe("low");
	} finally {
		writeFileSync(bgRunnerPath, BG_RUNNER_DEFINITION);
		await service.disposeChildrenOf(parent.sessionId);
	}
});

test("a definition edit during a model turn cannot split advertised and executed thinking policy", async () => {
	try {
		writeFileSync(
			bgRunnerPath,
			BG_RUNNER_DEFINITION.replace("model: fauxb", "model: fauxreasoner:xhigh\nthinking: low"),
		);
		fauxA.setResponses([
			() => {
				expect(toolInfo(parent, "Agent")?.description).toContain(
					"model: pinned fauxreasoner:xhigh; thinking: low (overrides suffix)",
				);
				writeFileSync(
					bgRunnerPath,
					BG_RUNNER_DEFINITION.replace("model: fauxb", "model: fauxb\nthinking: off"),
				);
				return fauxAssistantMessage(
					fauxToolCall("Agent", {
						subagent_type: "bg-runner",
						task: "Keep the advertised policy.",
						model: "missing:turbo",
					}),
				);
			},
			fauxAssistantMessage("SNAPSHOT_PRESERVED"),
		]);
		fauxReasoner.setResponses([fauxAssistantMessage("SNAPSHOT_CHILD")]);
		await parent.prompt("Delegate while the definition changes.");
		const context = await storedChildContext();
		expect(context.models.default).toBe("fauxreasoner/fauxreasoner");
		expect(context.thinkingLevel).toBe("low");
		expect(toolInfo(parent, "Agent")?.description).toContain(
			"model: pinned fauxb; thinking: off (overrides suffix)",
		);
	} finally {
		writeFileSync(bgRunnerPath, BG_RUNNER_DEFINITION);
		await service.disposeChildrenOf(parent.sessionId);
	}
});

test("zero-config fallback delegates through a provider registered by another extension", async () => {
	const extensionFaux = fauxCore("extension-faux");
	const standaloneDelegationRoot = tmpDir("pi-subagents-standalone-delegation-");
	const standalone = await bindSession((pi) => {
		pi.registerProvider("extension-faux", fauxConfig(extensionFaux, "extension-faux"));
		return createSubagentsExtension({
			delegationRoot: standaloneDelegationRoot,
			scope: "standalone",
		})(pi);
	});

	try {
		fauxA.setResponses([
			fauxAssistantMessage(
				fauxToolCall("Agent", {
					subagent_type: "extension-provider",
					task: "Use the shared provider.",
				}),
			),
			fauxAssistantMessage("PARENT_USED_EXTENSION_PROVIDER"),
		]);
		extensionFaux.setResponses([fauxAssistantMessage("EXTENSION_PROVIDER_CHILD_OK")]);

		await standalone.prompt("Delegate through the extension provider.");

		expect(JSON.stringify(standalone.messages)).toContain("EXTENSION_PROVIDER_CHILD_OK");
		expect(JSON.stringify(standalone.messages)).toContain("PARENT_USED_EXTENSION_PROVIDER");
		expect(runtime.find("extension-faux", "extension-faux")).toBeDefined();
	} finally {
		liveParents.delete(standalone.sessionId);
		await standalone.dispose();
		runtime.unregisterProvider("extension-faux");
	}
});

test("an unknown subagent_type surfaces as a tool error listing the available types", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "nope", task: "x" })),
		fauxAssistantMessage("PARENT_RECOVERED"),
	]);

	await parent.prompt("Send a nope.");

	const text = lastToolResultText();
	expect(text).toContain('Unknown subagent type "nope"');
	expect(text).toContain('"scout" (builtin)');
	expect(text).toContain("model: call or parent");
	expect(text).toContain("model: pinned fauxb");
	expect(service.childrenOf(parent.sessionId)).toEqual([]);
});

test("background: run_in_background returns immediately, completion arrives as a custom message", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "bg-runner",
				task: "Long job.",
				run_in_background: true,
			}),
		),
		fauxAssistantMessage("ACK_STARTED"),
		fauxAssistantMessage("GOT_COMPLETION"),
	]);
	fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);

	await parent.prompt("Run it in the background.");
	expect(transcript()).toContain("in the background:");

	await waitFor(() => transcript().includes("GOT_COMPLETION"));
	expect(transcript()).toContain(SUBAGENT_COMPLETION_MESSAGE);
	expect(transcript()).toContain("BG_RESULT");

	const child = service.childrenOf(parent.sessionId)[0];
	expect(child?.record.info.detached).toBe(true);
	expect(child?.collectResult()?.finalText).toBe("BG_RESULT");
	expect(child?.snapshot?.collected).toBe(true);
	await service.disposeChildrenOf(parent.sessionId);
});

function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

test.each([
	"user",
	undefined,
	"engine",
	"",
])("detached cancellation (%s) persists a displayed completion and only user cancellation avoids a parent turn", async (reason) => {
	const session = await makeSession();
	const started = gate();
	const finish = gate();
	const delivered = gate();
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			event.message.role === "custom" &&
			event.message.customType === SUBAGENT_COMPLETION_MESSAGE
		) {
			delivered.open();
		}
	});
	try {
		fauxA.setResponses([
			fauxAssistantMessage(
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "Wait for cancellation.",
					run_in_background: true,
				}),
			),
			fauxAssistantMessage("ACK_STARTED"),
			fauxAssistantMessage("FOLLOW_UP"),
		]);
		fauxB.setResponses([
			async () => {
				started.open();
				await finish.opened;
				return fauxAssistantMessage("INTERRUPTED");
			},
		]);
		await session.prompt("Delegate, then wait.");
		await started.opened;
		const child = service.childrenOf(session.sessionId).at(-1);
		if (!child) throw new Error("no child spawned");
		expect(child.snapshot?.status).toBe("running");
		expect(session.isStreaming).toBe(false);
		const callsBeforeStop = fauxA.state.callCount;

		const aborting = Promise.all([child.abort(reason), child.abort("user")]);
		finish.open();
		await aborting;
		await delivered.opened;
		if (reason !== "user") {
			await waitFor(() => JSON.stringify(session.messages).includes("FOLLOW_UP"));
		}
		await Bun.sleep(20);
		expect(fauxA.state.callCount).toBe(callsBeforeStop + (reason === "user" ? 0 : 1));
		expect(session.isStreaming).toBe(false);
		expect(child.snapshot?.details.abortReason).toBe(reason);
		const completions = session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom_message" && entry.customType === SUBAGENT_COMPLETION_MESSAGE,
			);
		expect(completions).toHaveLength(1);
		const completion = completions[0];
		if (completion?.type !== "custom_message") throw new Error("missing completion");
		expect(completion).toMatchObject({
			display: true,
			details: child.snapshot?.details,
		});
		expect(completion.content).toContain("aborted:");

		if (reason === "user") {
			expect(fauxA.getPendingResponseCount()).toBe(1);
			fauxA.setResponses([
				fauxAssistantMessage(
					fauxToolCall("Agent", { subagent_type: "bg-runner", task: "Delegate again." }),
				),
				fauxAssistantMessage("PARENT_CONTINUES"),
			]);
			fauxB.setResponses([fauxAssistantMessage("NEXT_CHILD")]);
			await session.prompt("Keep working.");
			expect(lastToolResultText(session)).toBe("NEXT_CHILD");
			expect(service.childrenOf(session.sessionId)).toHaveLength(2);
		}
	} finally {
		finish.open();
		unsubscribe();
		await service.disposeChildrenOf(session.sessionId);
		liveParents.delete(session.sessionId);
		await session.dispose();
	}
});

test("a foreground error outcome surfaces as a tool error carrying the reason", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "scout", task: "Fail." })),
		fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "boom" }),
		fauxAssistantMessage("PARENT_SAW_ERROR"),
	]);

	await parent.prompt("Send a doomed scout.");

	const text = lastToolResultText();
	expect(text).toContain("failed: boom");

	const child = service.childrenOf(parent.sessionId).at(-1);
	if (!child) throw new Error("no child spawned");
	const result = parent.messages.filter((m) => m.role === "toolResult").at(-1) as {
		isError: boolean;
		details?: { childSessionId?: string; status?: string };
	};
	expect(result.isError).toBe(true);
	expect(result.details?.childSessionId).toBe(child.sessionId);
	expect(result.details?.status).toBe("error");
	await service.disposeChildrenOf(parent.sessionId);
});

test("max_turns flows from the definition into the run: the cap steers the wrap-up", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "capped", task: "Loop." })),
		fauxAssistantMessage(fauxToolCall("ls", {})),
		fauxAssistantMessage("WRAPPED_UP"),
		fauxAssistantMessage("PARENT_OK"),
	]);

	await parent.prompt("Run the capped agent.");

	expect(lastToolResultText()).toContain("WRAPPED_UP");
	const child = service.childrenOf(parent.sessionId).at(-1);
	expect(child?.snapshot?.status).toBe("completed");
	expect(child?.snapshot?.details.usage.turns).toBe(2);
	await service.disposeChildrenOf(parent.sessionId);
});

test("a detached run SURVIVES a parent-turn abort (only awaited runs ride the tool signal)", async () => {
	const ackStarted = deferred();
	const releaseChild = deferred();
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "bg-runner",
				task: "Slow job.",
				run_in_background: true,
			}),
		),
		async (_context, options) => {
			ackStarted.resolve();
			await new Promise((resolve) =>
				options?.signal?.addEventListener("abort", resolve, { once: true }),
			);
			return fauxAssistantMessage("SLOW_ACK");
		},
		fauxAssistantMessage("POST_ABORT_COMPLETION"),
	]);
	fauxB.setResponses([
		async () => {
			await releaseChild.promise;
			return fauxAssistantMessage("SURVIVED");
		},
	]);

	const prompted = parent.prompt("Run it, then get interrupted.");
	await ackStarted.promise;
	await parent.abort();
	await prompted;

	const child = service.childrenOf(parent.sessionId).at(-1);
	expect(child?.snapshot?.status).toBe("running");
	expect(transcript()).not.toContain("SLOW_ACK");
	releaseChild.resolve();
	await waitFor(() => child?.snapshot?.status === "completed");
	expect(child?.snapshot?.finalText).toBe("SURVIVED");
	await waitFor(() => transcript().includes("POST_ABORT_COMPLETION"));
	expect(transcript()).toContain(SUBAGENT_COMPLETION_MESSAGE);
	await service.disposeChildrenOf(parent.sessionId);
});

test("boundedText: reason-first errors, terminal fallbacks, and the 50k bound (every report path)", () => {
	expect(boundedText({ status: "error", errorMessage: "boom", finalText: "partial" })).toBe(
		"boom\n\npartial",
	);
	expect(boundedText({ status: "error" })).toBe("unknown error");
	expect(boundedText({ status: "completed" })).toBe("(no output)");
	expect(boundedText({ status: "aborted" })).toBe("Run aborted.");
	const huge = boundedText({ status: "completed", finalText: "Y".repeat(60_000) });
	expect(huge.endsWith("[truncated]")).toBe(true);
	expect(huge.length).toBeLessThan(50_100);
});

test("get_subagent_result collects a detached ERROR through the same reason-first shaping", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "bg-runner",
				task: "Doomed job.",
				run_in_background: true,
			}),
		),
		fauxAssistantMessage("ACK_BG"),
		fauxAssistantMessage("SAW_FAILURE"),
	]);
	fauxB.setResponses([
		fauxAssistantMessage("partial work", { stopReason: "error", errorMessage: "child exploded" }),
	]);

	await parent.prompt("Run the doomed job.");
	await waitFor(() => transcript().includes("SAW_FAILURE"));
	const child = service.childrenOf(parent.sessionId).at(-1);
	if (!child) throw new Error("no child spawned");

	fauxA.setResponses([
		fauxAssistantMessage(fauxToolCall("get_subagent_result", { session_id: child.sessionId })),
		fauxAssistantMessage("COLLECTED"),
	]);
	await parent.prompt("Collect it.");

	const text = lastToolResultText();
	expect(text).toContain("Run error: child exploded");
	expect(text).toContain("partial work");
	await service.disposeChildrenOf(parent.sessionId);
});

test("get_subagent_result rejects another parent's child — lineage is enforced on the shared service", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", { subagent_type: "bg-runner", task: "Mine.", run_in_background: true }),
		),
		fauxAssistantMessage("OWNER_ACK"),
		fauxAssistantMessage("OWNER_SAW_COMPLETION"),
	]);
	fauxB.setResponses([fauxAssistantMessage("OWNER_RESULT")]);
	await parent.prompt("Run mine.");
	await waitFor(() => transcript().includes("OWNER_SAW_COMPLETION"));
	const child = service.childrenOf(parent.sessionId).at(-1);
	if (!child) throw new Error("no child spawned");

	const other = await makeSession();
	try {
		fauxA.setResponses([
			fauxAssistantMessage(fauxToolCall("get_subagent_result", { session_id: child.sessionId })),
			fauxAssistantMessage("OTHER_HANDLED"),
		]);
		await other.prompt("Collect someone else's child.");
		expect(lastToolResultText(other)).toContain(`Unknown subagent session ${child.sessionId}`);
		expect(child.snapshot?.collected).toBe(false);
	} finally {
		await other.dispose();
		await service.disposeChildrenOf(parent.sessionId);
	}
});

test("get_subagent_result on an unknown id explains the restart-loss case", async () => {
	fauxA.setResponses([
		fauxAssistantMessage(fauxToolCall("get_subagent_result", { session_id: "bogus" })),
		fauxAssistantMessage("OK_HANDLED"),
	]);

	await parent.prompt("Collect bogus.");

	expect(lastToolResultText()).toContain("Unknown subagent session bogus");
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function completions(session: AgentSession) {
	return session.messages.filter(
		(message) => message.role === "custom" && message.customType === SUBAGENT_COMPLETION_MESSAGE,
	);
}

async function launchDetached(session: AgentSession) {
	const finish = deferred();
	const entered = deferred();
	fauxA.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "bg-runner",
				task: "Retained completion",
				run_in_background: true,
			}),
		),
		fauxAssistantMessage("DETACHED_ACK"),
		fauxAssistantMessage("DELIVERED_COMPLETION"),
	]);
	fauxB.setResponses([
		async () => {
			entered.resolve();
			await finish.promise;
			return fauxAssistantMessage("RETAINED_RESULT");
		},
	]);
	await session.prompt("Delegate in the background.");
	await entered.promise;
	return finish;
}

test("retained completion waits behind a closed gate, then repeated flush accepts exactly once", async () => {
	let allowed = false;
	let enabled = true;
	const owner = createSubagents({
		service,
		canDeliverCompletion: () => allowed,
		isEnabled: () => enabled,
	});
	expect(Object.keys(owner).sort()).toEqual(["dispose", "extension", "flushCompletions"]);
	const session = await makeSession(undefined, service, owner.extension);
	let starts = 0;
	session.subscribe((event) => {
		if (event.type === "agent_start") starts++;
	});
	const finish = await launchDetached(session);
	try {
		finish.resolve();
		await waitFor(() => service.childrenOf(session.sessionId)[0]?.snapshot?.status === "completed");
		owner.flushCompletions();
		expect(completions(session)).toHaveLength(0);
		expect(
			session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
		).toHaveLength(0);
		expect(starts).toBe(1);
		enabled = false;
		allowed = true;
		owner.flushCompletions();
		owner.flushCompletions();
		await waitFor(() => !session.isStreaming && completions(session).length === 1);
		expect(starts).toBe(2);
		expect(JSON.stringify(completions(session))).toContain("RETAINED_RESULT");
	} finally {
		finish.resolve();
		owner.dispose();
		await service.disposeChildrenOf(session.sessionId);
		await session.dispose();
	}
});

test.each([
	"gap",
	"rebound",
])("a rebuilt parent session retains completion settling in the %s and ignores stale unbind", async (timing) => {
	const owner = createSubagents({ service });
	let bindings = 0;
	const sends: number[] = [];
	const factory: ExtensionFactory = (pi) => {
		const binding = ++bindings;
		owner.extension(
			withSendMessage(pi, (message, options) => {
				sends.push(binding);
				pi.sendMessage(message, options);
			}),
		);
	};
	const first = await makeSession(undefined, service, factory);
	const oldRunner = first.extensionRunner;
	const finish = await launchDetached(first);
	await first.waitForIdle();
	liveParents.delete(first.sessionId);
	await first.dispose();
	let rebound: AgentSession | undefined;
	try {
		if (timing === "gap") {
			finish.resolve();
			await waitFor(() => service.childrenOf(first.sessionId)[0]?.snapshot?.status === "completed");
			owner.flushCompletions();
			expect(sends).toEqual([]);
		}
		rebound = await makeSession(undefined, service, factory, first.sessionManager);
		await oldRunner?.emit({ type: "session_shutdown" });
		finish.resolve();
		const session = rebound;
		await waitFor(() => !session.isStreaming && completions(session).length === 1);
		owner.flushCompletions();
		expect(sends).toEqual([2]);
		expect(service.childrenOf(session.sessionId)).toHaveLength(1);
		expect(session.getAllToolNames().filter((name) => name === "Agent")).toHaveLength(1);
	} finally {
		finish.resolve();
		owner.dispose();
		await service.disposeChildrenOf(first.sessionId);
		if (rebound) {
			liveParents.delete(rebound.sessionId);
			await rebound.dispose();
		}
	}
});

test.each([
	"dispose",
	"quit",
])("permanent %s clears pending and future outcomes and cannot rebind open", async (close) => {
	let allowed = false;
	const owner =
		close === "dispose"
			? createSubagents({ service, canDeliverCompletion: () => allowed })
			: undefined;
	const session = await makeSession(
		undefined,
		service,
		owner?.extension ?? createSubagentsExtension({ service, canDeliverCompletion: () => allowed }),
	);
	const first = await launchDetached(session);
	first.resolve();
	await waitFor(() => service.childrenOf(session.sessionId)[0]?.snapshot?.status === "completed");
	const second = await launchDetached(session);
	try {
		if (owner) owner.dispose();
		else await session.extensionRunner?.emit({ type: "session_shutdown" });
		allowed = true;
		await session.reload();
		second.resolve();
		await waitFor(() =>
			service
				.childrenOf(session.sessionId)
				.every((child) => child.snapshot?.status === "completed"),
		);
		owner?.flushCompletions();
		await macrotask();
		expect(completions(session)).toHaveLength(0);
		expect(session.isStreaming).toBe(false);
	} finally {
		second.resolve();
		owner?.dispose();
		await service.disposeChildrenOf(session.sessionId);
		await session.dispose();
	}
});

test.each([
	false,
	true,
])("sync send failure restores its claim unless disposed (dispose: %s), reentrance never duplicates", async (disposeOnFailure) => {
	let allowed = false;
	let attempts = 0;
	const owner = createSubagents({ service, canDeliverCompletion: () => allowed });
	const session = await makeSession(undefined, service, (pi) =>
		owner.extension(
			withSendMessage(pi, (message, options) => {
				attempts++;
				owner.flushCompletions();
				if (attempts === 1) {
					if (disposeOnFailure) owner.dispose();
					throw new Error("synchronous rejection");
				}
				pi.sendMessage(message, options);
				owner.flushCompletions();
			}),
		),
	);
	const finish = await launchDetached(session);
	try {
		finish.resolve();
		await waitFor(() => service.childrenOf(session.sessionId)[0]?.snapshot?.status === "completed");
		allowed = true;
		owner.flushCompletions();
		expect(attempts).toBe(1);
		expect(completions(session)).toHaveLength(0);
		owner.flushCompletions();
		owner.flushCompletions();
		await waitFor(
			() => !session.isStreaming && (disposeOnFailure || completions(session).length === 1),
		);
		expect(attempts).toBe(disposeOnFailure ? 1 : 2);
		expect(completions(session)).toHaveLength(disposeOnFailure ? 0 : 1);
	} finally {
		finish.resolve();
		owner.dispose();
		await service.disposeChildrenOf(session.sessionId);
		await session.dispose();
	}
});

test.each([
	["default factory shutdown", "default", false],
	["legacy injected-service factory natural completion", "legacy", false],
	["legacy injected-service factory explicit user abort after shutdown", "legacy", true],
] as const)("one %s keeps independent runner lifetimes", async (_name, kind, userStop) => {
	const factory = kind === "default" ? defaultSubagents : createSubagentsExtension({ service });
	const first = await makeSession(undefined, service, factory);
	const second = await makeSession(undefined, service, factory);
	const firstFinish = await launchDetached(first);
	try {
		const child = service.childrenOf(first.sessionId)[0];
		const closing = first.extensionRunner?.emit({ type: "session_shutdown" });
		let aborting: Promise<void> | undefined;
		if (kind === "legacy") {
			await closing;
			if (!child) throw new Error("no child spawned");
			if (userStop) aborting = child.abort("user");
		}
		firstFinish.resolve();
		await Promise.all([closing, aborting]);
		if (kind === "legacy")
			await waitFor(() => child?.snapshot?.status === (userStop ? "aborted" : "completed"));
		expect(completions(first)).toHaveLength(0);
		const finish = await launchDetached(second);
		finish.resolve();
		await waitFor(() => !second.isStreaming && completions(second).length === 1);
		expect(completions(first)).toHaveLength(0);
		expect(first.sessionManager.getEntries().some((entry) => entry.type === "custom_message")).toBe(
			false,
		);
		expect(JSON.stringify(completions(second))).toContain("RETAINED_RESULT");
	} finally {
		firstFinish.resolve();
		await second.extensionRunner?.emit({ type: "session_shutdown" });
		await service.disposeChildrenOf(first.sessionId);
		await service.disposeChildrenOf(second.sessionId);
		await first.dispose();
		await second.dispose();
	}
});

test("a retained owner rejects another parent without replacing the original sender", async () => {
	const owner = createSubagents({ service });
	const session = await makeSession(undefined, service, owner.extension);
	try {
		await expect(makeSession(undefined, service, owner.extension)).rejects.toThrow(
			"Subagents belong to a different session",
		);
		const finish = await launchDetached(session);
		finish.resolve();
		await waitFor(() => !session.isStreaming && completions(session).length === 1);
	} finally {
		owner.dispose();
		await service.disposeChildrenOf(session.sessionId);
		await session.dispose();
	}
});

test("a previous live runner's reload shutdown cannot unbind a newer sender for the same parent", async () => {
	const owner = createSubagents({ service });
	const first = await makeSession(undefined, service, owner.extension);
	const finish = await launchDetached(first);
	const rebound = await makeSession(undefined, service, owner.extension, first.sessionManager);
	try {
		await first.extensionRunner?.emit({ type: "session_shutdown" });
		finish.resolve();
		await waitFor(() => !rebound.isStreaming && completions(rebound).length === 1);
		expect(completions(first)).toHaveLength(0);
		owner.flushCompletions();
		expect(completions(rebound)).toHaveLength(1);
	} finally {
		finish.resolve();
		owner.dispose();
		await service.disposeChildrenOf(first.sessionId);
		await first.dispose();
		await rebound.dispose();
	}
});

function macrotask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function lastChild(session: AgentSession) {
	const child = service.childrenOf(session.sessionId).at(-1);
	if (!child) throw new Error("no child spawned");
	return child;
}

async function childHeld(session: AgentSession, count = 1) {
	await waitFor(() => {
		const children = service.childrenOf(session.sessionId);
		return (
			children.length >= count && children.every((child) => child.snapshot?.status === "completed")
		);
	});
	await macrotask();
}

function deliveries(session: AgentSession) {
	return session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === SUBAGENT_COMPLETION_MESSAGE
				? [(entry.details as { delivery?: string }).delivery]
				: [],
		);
}

function countSettles(session: AgentSession) {
	const counter = { settles: 0 };
	session.subscribe((event) => {
		if (event.type === "agent_end" && event.yielded !== false) counter.settles++;
	});
	return counter;
}

function requestText(context: { messages: unknown[] }): string {
	return JSON.stringify(context.messages);
}

function background(task: string) {
	return fauxAssistantMessage(
		fauxToolCall("Agent", { subagent_type: "bg-runner", task, run_in_background: true }),
	);
}

async function closeSession(session: AgentSession) {
	await service.disposeChildrenOf(session.sessionId);
	liveParents.delete(session.sessionId);
	await session.dispose();
}

test("a detached result the parent already pulled mid-run is never delivered again", async () => {
	const session = await makeSession();
	try {
		fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);
		fauxA.setResponses([
			background("Job."),
			async () => {
				await childHeld(session);
				return fauxAssistantMessage(
					fauxToolCall("get_subagent_result", { session_id: lastChild(session).sessionId }),
				);
			},
			fauxAssistantMessage("DONE"),
			fauxAssistantMessage("ALREADY_HANDLED"),
		]);
		const before = fauxA.state.callCount;
		await session.prompt("Delegate in the background, keep working, pull the result.");
		await macrotask();
		expect(completions(session)).toHaveLength(0);
		expect(fauxA.state.callCount - before).toBe(3);
		expect(JSON.stringify(session.messages)).not.toContain("ALREADY_HANDLED");
	} finally {
		await closeSession(session);
	}
});

test("a result pulled before Stop never surfaces after the next, unrelated prompt", async () => {
	const session = await makeSession();
	const parked = deferred();
	try {
		fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);
		fauxA.setResponses([
			background("Job."),
			async () => {
				await childHeld(session);
				return fauxAssistantMessage(
					fauxToolCall("get_subagent_result", { session_id: lastChild(session).sessionId }),
				);
			},
			async (_context, options) => {
				parked.resolve();
				await new Promise((resolve) =>
					options?.signal?.addEventListener("abort", resolve, { once: true }),
				);
				return fauxAssistantMessage("ABORTED");
			},
		]);
		const run = session.prompt("Delegate, pull, then get stopped.");
		await parked.promise;
		await session.abort();
		await run;
		await macrotask();
		fauxA.setResponses([fauxAssistantMessage("ANSWER"), fauxAssistantMessage("ALREADY_HANDLED")]);
		await session.prompt("An unrelated question.");
		await macrotask();
		expect(completions(session)).toHaveLength(0);
		expect(JSON.stringify(session.messages)).not.toContain("ALREADY_HANDLED");
	} finally {
		await closeSession(session);
	}
});

test("a result finishing during a tool turn reaches the very next request of the same run", async () => {
	const session = await makeSession();
	const counter = countSettles(session);
	let sawReport = false;
	try {
		fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);
		fauxA.setResponses([
			background("Job."),
			async () => {
				await childHeld(session);
				return fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }));
			},
			(context) => {
				sawReport = requestText(context).includes("BG_RESULT");
				return fauxAssistantMessage("DONE");
			},
		]);
		const before = fauxA.state.callCount;
		await session.prompt("Delegate and keep working.");
		await macrotask();
		expect(sawReport).toBe(true);
		expect(fauxA.state.callCount - before).toBe(3);
		expect(counter.settles).toBe(1);
		expect(deliveries(session)).toEqual(["run"]);
	} finally {
		await closeSession(session);
	}
});

test("a result deliverable only once a tool returns joins the request right after its batch", async () => {
	let open = false;
	const owner = createSubagents({ service, canDeliverCompletion: () => open });
	const stepStarted = Promise.withResolvers<void>();
	const launchTurnHandled = Promise.withResolvers<void>();
	const launchTurn = (event: TurnEndEvent) =>
		event.toolResults.some((result) => result.toolName === "Agent");
	const session = await makeSession(undefined, service, (pi) => {
		pi.on("turn_end", async (event) => {
			if (launchTurn(event)) await stepStarted.promise;
			else await Bun.sleep(50);
		});
		const bound = owner.extension(pi);
		pi.on("turn_end", (event) => {
			if (launchTurn(event)) launchTurnHandled.resolve();
		});
		pi.registerTool({
			name: "gated_step",
			label: "Gated step",
			description: "Opens the delivery gate before returning",
			parameters: z.object({}),
			loadMode: "essential",
			async execute() {
				stepStarted.resolve();
				await launchTurnHandled.promise;
				open = true;
				return { content: [{ type: "text", text: "GATED_RESULT" }], details: {} };
			},
		});
		return bound;
	});
	const counter = countSettles(session);
	let sawReport = false;
	try {
		fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);
		fauxA.setResponses([
			background("Job."),
			async () => {
				await childHeld(session);
				return fauxAssistantMessage(fauxToolCall("gated_step", {}));
			},
			(context) => {
				sawReport = requestText(context).includes("BG_RESULT");
				return fauxAssistantMessage("DONE");
			},
			fauxAssistantMessage("LATE_RESULT"),
		]);
		const before = fauxA.state.callCount;
		await session.prompt("Delegate, then take the gated step.");
		await macrotask();
		expect(sawReport).toBe(true);
		expect(fauxA.state.callCount - before).toBe(3);
		expect(counter.settles).toBe(1);
		expect(deliveries(session)).toEqual(["run"]);
		const tail = session.messages.slice(-3);
		expect(tail.map((m) => m.role)).toEqual(["toolResult", "custom", "assistant"]);
		expect(JSON.stringify(tail[0])).toContain("GATED_RESULT");
		expect(JSON.stringify(session.messages)).not.toContain("LATE_RESULT");
	} finally {
		owner.dispose();
		await closeSession(session);
	}
});

test("a result finishing during the final turn continues the same run instead of a new one", async () => {
	const session = await makeSession();
	const counter = countSettles(session);
	let sawReport = false;
	try {
		fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);
		fauxA.setResponses([
			background("Job."),
			async () => {
				await childHeld(session);
				return fauxAssistantMessage("WORK_DONE");
			},
			(context) => {
				sawReport = requestText(context).includes("BG_RESULT");
				return fauxAssistantMessage("REACTED");
			},
		]);
		await session.prompt("Delegate and finish.");
		await macrotask();
		expect(sawReport).toBe(true);
		expect(counter.settles).toBe(1);
		expect(deliveries(session)).toEqual(["run"]);
		expect(JSON.stringify(session.messages.at(-1))).toContain("REACTED");
	} finally {
		await closeSession(session);
	}
});

test("several results held at one boundary arrive together in one request", async () => {
	const session = await makeSession();
	const counter = countSettles(session);
	let reports = 0;
	try {
		fauxB.setResponses([
			fauxAssistantMessage("FIRST_RESULT"),
			fauxAssistantMessage("SECOND_RESULT"),
		]);
		fauxA.setResponses([
			fauxAssistantMessage([
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "One.",
					run_in_background: true,
				}),
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "Two.",
					run_in_background: true,
				}),
			]),
			async () => {
				await childHeld(session, 2);
				return fauxAssistantMessage("WORK_DONE");
			},
			(context) => {
				const text = requestText(context);
				reports = ["FIRST_RESULT", "SECOND_RESULT"].filter((r) => text.includes(r)).length;
				return fauxAssistantMessage("REACTED_TO_BOTH");
			},
		]);
		const before = fauxA.state.callCount;
		await session.prompt("Fan out and finish.");
		await macrotask();
		expect(reports).toBe(2);
		expect(fauxA.state.callCount - before).toBe(3);
		expect(counter.settles).toBe(1);
		expect(deliveries(session)).toEqual(["run", "run"]);
	} finally {
		await closeSession(session);
	}
});

test("results released to an idle parent together wake exactly one run", async () => {
	let allowed = false;
	const owner = createSubagents({ service, canDeliverCompletion: () => allowed });
	const session = await makeSession(undefined, service, owner.extension);
	const counter = countSettles(session);
	let reports = 0;
	try {
		fauxB.setResponses([
			fauxAssistantMessage("FIRST_RESULT"),
			fauxAssistantMessage("SECOND_RESULT"),
		]);
		fauxA.setResponses([
			fauxAssistantMessage([
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "One.",
					run_in_background: true,
				}),
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "Two.",
					run_in_background: true,
				}),
			]),
			fauxAssistantMessage("STARTED_BOTH"),
			(context) => {
				const text = requestText(context);
				reports = ["FIRST_RESULT", "SECOND_RESULT"].filter((r) => text.includes(r)).length;
				return fauxAssistantMessage("WOKEN_ONCE");
			},
			fauxAssistantMessage("SECOND_WAKE"),
		]);
		await session.prompt("Fan out in the background.");
		await childHeld(session, 2);
		expect(completions(session)).toHaveLength(0);
		allowed = true;
		owner.flushCompletions();
		await waitFor(() => !session.isStreaming && counter.settles === 2);
		await macrotask();
		expect(counter.settles).toBe(2);
		expect(reports).toBe(2);
		expect(deliveries(session)).toEqual(["wake", "run"]);
		expect(JSON.stringify(session.messages)).not.toContain("SECOND_WAKE");
	} finally {
		owner.dispose();
		await closeSession(session);
	}
});

test("a result held when the user stops the parent is shown without waking it", async () => {
	const session = await makeSession();
	const counter = countSettles(session);
	const parked = deferred();
	try {
		fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);
		fauxA.setResponses([
			background("Job."),
			async (_context, options) => {
				await childHeld(session);
				parked.resolve();
				await new Promise((resolve) =>
					options?.signal?.addEventListener("abort", resolve, { once: true }),
				);
				return fauxAssistantMessage("ABORTED");
			},
			fauxAssistantMessage("WOKE_AFTER_STOP"),
		]);
		const run = session.prompt("Delegate, then get stopped.");
		await parked.promise;
		const callsAtStop = fauxA.state.callCount;
		await session.abort();
		await run;
		await waitFor(() => completions(session).length === 1);
		await macrotask();
		expect(deliveries(session)).toEqual(["appended"]);
		expect(fauxA.state.callCount).toBe(callsAtStop);
		expect(counter.settles).toBe(1);
		expect(session.isStreaming).toBe(false);
	} finally {
		await closeSession(session);
	}
});

test("results held when a provider error ends the run wake the parent once", async () => {
	const session = await makeSession();
	const counter = countSettles(session);
	let sawReport = false;
	try {
		fauxB.setResponses([fauxAssistantMessage("BG_RESULT")]);
		fauxA.setResponses([
			background("Job."),
			async () => {
				await childHeld(session);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" });
			},
			(context) => {
				sawReport = requestText(context).includes("BG_RESULT");
				return fauxAssistantMessage("RECOVERED");
			},
		]);
		await session.prompt("Delegate, then hit a provider error.");
		await waitFor(() => !session.isStreaming && counter.settles >= 1);
		await macrotask();
		expect(sawReport).toBe(true);
		expect(counter.settles).toBe(1);
		expect(deliveries(session)).toEqual(["run"]);
	} finally {
		await closeSession(session);
	}
});

test("get_subagent_result tells the model a run is still going and that its report will arrive", async () => {
	const session = await makeSession();
	const release = deferred();
	try {
		fauxB.setResponses([
			async () => {
				await release.promise;
				return fauxAssistantMessage("LATE_RESULT");
			},
		]);
		fauxA.setResponses([
			background("Slow job."),
			async () =>
				fauxAssistantMessage(
					fauxToolCall("get_subagent_result", { session_id: lastChild(session).sessionId }),
				),
			fauxAssistantMessage("WILL_WAIT"),
		]);
		await session.prompt("Delegate and check once.");
		expect(lastToolResultText(session)).toContain("delivered to you automatically");
	} finally {
		release.resolve();
		await closeSession(session);
	}
});

test("a pulled aborted run states that it was aborted and why", async () => {
	const session = await makeSession();
	const started = deferred();
	const finish = deferred();
	try {
		fauxB.setResponses([
			async () => {
				started.resolve();
				await finish.promise;
				return fauxAssistantMessage("PARTIAL");
			},
		]);
		fauxA.setResponses([background("Interrupted job."), fauxAssistantMessage("ACK")]);
		await session.prompt("Delegate.");
		await started.promise;
		const child = lastChild(session);
		const aborting = child.abort("user");
		finish.resolve();
		await aborting;
		await waitFor(() => completions(session).length === 1);
		fauxA.setResponses([
			fauxAssistantMessage(fauxToolCall("get_subagent_result", { session_id: child.sessionId })),
			fauxAssistantMessage("READ_IT"),
		]);
		await session.prompt("Read the stopped run.");
		expect(lastToolResultText(session)).toStartWith("Run aborted (user)");
	} finally {
		finish.resolve();
		await closeSession(session);
	}
});

test("a rejected waking send keeps the wake for the retry instead of losing it", async () => {
	let allowed = false;
	let rejectWake = true;
	const owner = createSubagents({ service, canDeliverCompletion: () => allowed });
	const session = await makeSession(undefined, service, (pi) =>
		owner.extension(
			withSendMessage(pi, (message, options) => {
				if (options?.triggerTurn && rejectWake) {
					rejectWake = false;
					throw new Error("runtime unavailable");
				}
				pi.sendMessage(message, options);
			}),
		),
	);
	const counter = countSettles(session);
	const stoppedStarted = deferred();
	const releaseStopped = deferred();
	let sawNatural = false;
	try {
		const child = async (context: { messages: unknown[] }) => {
			if (!requestText(context).includes("Stopped.")) return fauxAssistantMessage("NATURAL_RESULT");
			stoppedStarted.resolve();
			await releaseStopped.promise;
			return fauxAssistantMessage("STOPPED_PARTIAL");
		};
		fauxB.setResponses([child, child]);
		fauxA.setResponses([
			fauxAssistantMessage([
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "Natural.",
					run_in_background: true,
				}),
				fauxToolCall("Agent", {
					subagent_type: "bg-runner",
					task: "Stopped.",
					run_in_background: true,
				}),
			]),
			fauxAssistantMessage("STARTED_BOTH"),
			(context) => {
				sawNatural = requestText(context).includes("NATURAL_RESULT");
				return fauxAssistantMessage("WOKEN");
			},
		]);
		await session.prompt("Fan out.");
		await stoppedStarted.promise;
		const stopped = service
			.childrenOf(session.sessionId)
			.find((child) => child.snapshot?.task === "Stopped.");
		if (!stopped) throw new Error("missing stopped child");
		const aborting = stopped.abort("user");
		releaseStopped.resolve();
		await aborting;
		await waitFor(() =>
			service
				.childrenOf(session.sessionId)
				.every(
					(child) => child.snapshot?.status === "completed" || child.snapshot?.status === "aborted",
				),
		);
		await macrotask();
		allowed = true;
		owner.flushCompletions();
		await waitFor(() => completions(session).length === 1);
		expect(counter.settles).toBe(1);
		owner.flushCompletions();
		await waitFor(() => !session.isStreaming && counter.settles === 2);
		expect(sawNatural).toBe(true);
		expect(completions(session)).toHaveLength(2);
	} finally {
		releaseStopped.resolve();
		owner.dispose();
		await closeSession(session);
	}
});
