import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionRunner,
	SessionManager,
	Settings,
	type TurnEndEvent,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
	createFauxCore,
	createFauxModelRegistry,
	fauxAssistantMessage,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";
import backgroundCommandsExtension, {
	BACKGROUND_COMMAND_COMPLETION_MESSAGE,
	type BackgroundCommandContext,
	createBackgroundCommands,
	createBackgroundCommandsExtension,
} from "../index";
import { controlledOperations, waitFor } from "./test-support";

const cwd = mkdtempSync(join(tmpdir(), "pi-background-"));
const agentDir = join(cwd, "agent");

let agentDirIsolation: IsolatedAgentDir | undefined;
let priorOffline: string | undefined;
const faux = createFauxCore({
	provider: "background-test",
	api: "background-test",
	models: [
		{
			id: "background-test",
			name: "background-test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 4096,
		},
	],
	tokensPerSecond: 4000,
});

beforeAll(() => {
	agentDirIsolation = isolateAgentDir(agentDir);
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
});

afterAll(() => {
	agentDirIsolation?.restore();
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
	rmSync(cwd, { recursive: true, force: true });
});

type ThinkingSelection = NonNullable<Parameters<AgentSession["setThinkingLevel"]>[0]>;

function isThinking(value: string): value is ThinkingSelection {
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function thinking(value: string): ThinkingSelection {
	if (!isThinking(value)) throw new Error(`Unknown thinking level ${value}`);
	return value;
}

async function makeSession(
	factory: ExtensionFactory = backgroundCommandsExtension,
	sessionManager = SessionManager.inMemory(cwd),
	extraFactories: ExtensionFactory[] = [],
	overrides: Record<string, unknown> = {},
) {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		...overrides,
	});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const model = registerFaux(modelRegistry, faux);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager,
		extensions: [factory, ...extraFactories],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	await initializeExtensions(session, {
		reportSendError: () => {},
		reportRuntimeError: () => {},
	});
	return session;
}

function runner(session: AgentSession): ExtensionRunner {
	const extensionRunner = session.extensionRunner;
	if (!extensionRunner) throw new Error("Missing extension runner");
	return extensionRunner;
}

function completionMessages(session: AgentSession) {
	return session.messages.filter(
		(m) => m.role === "custom" && m.customType === BACKGROUND_COMMAND_COMPLETION_MESSAGE,
	);
}

function toolTurn(...calls: ReturnType<typeof fauxToolCall>[]) {
	return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

function startCommand(command: string) {
	return toolTurn(fauxToolCall("background_command", { action: "start", command }));
}

test("vanilla Pi calls the real command tool, acknowledges immediately, and receives a natural follow-up", async () => {
	const session = await makeSession();
	try {
		expect(session.getActiveToolNames()).toContain("background_command");
		faux.setResponses([
			startCommand("sleep 0.1; printf REAL_RESULT"),
			fauxAssistantMessage("ACKNOWLEDGED"),
			fauxAssistantMessage("SAW_COMPLETION"),
		]);
		await session.prompt("Start a managed command.");
		await waitFor(() => JSON.stringify(session.messages).includes("SAW_COMPLETION"));
		const custom = completionMessages(session)[0];
		expect(custom).toMatchObject({ role: "custom", display: true });
		expect(JSON.stringify(custom)).toContain("REAL_RESULT");
		expect(session.getActiveToolNames()).toContain("bash");
		expect(session.getToolByName("bash")?.description).not.toContain("background_command");
	} finally {
		await session.dispose();
	}
});

test("injected jobs survive a session reopen; a completion in the gap replays once into the new binding", async () => {
	const executor = controlledOperations();
	const sessionDir = join(cwd, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const sm = SessionManager.create(cwd, sessionDir);
	const sessionId = sm.getSessionId();
	const service = createBackgroundCommands({ sessionId, getContext: () => ({ cwd }) }, executor);
	const first = await makeSession(createBackgroundCommandsExtension({ service }), sm);
	let second: AgentSession | undefined;
	let third: AgentSession | undefined;
	try {
		faux.setResponses([
			startCommand("gated"),
			fauxAssistantMessage("ACK"),
			fauxAssistantMessage("REPLAYED"),
		]);
		await first.prompt("Start.");
		const sessionFile = first.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing session file");
		await first.dispose();
		expect(executor.call().options.signal.aborted).toBe(false);
		executor.call().resolve({ exitCode: 0 });
		await waitFor(() => service.list()[0]?.status === "completed");
		second = await makeSession(
			createBackgroundCommandsExtension({ service }),
			await SessionManager.open(sessionFile, sessionDir),
		);
		expect(second.sessionId).toBe(sessionId);
		const reopened = second;
		await waitFor(() => JSON.stringify(reopened.messages).includes("REPLAYED"));
		await reopened.waitForIdle();
		await reopened.dispose();
		third = await makeSession(
			createBackgroundCommandsExtension({ service }),
			await SessionManager.open(sessionFile, sessionDir),
		);
		await macrotask();
		expect(completionMessages(third)).toHaveLength(1);
	} finally {
		await third?.dispose();
		await service.dispose();
	}
});

function envDigest(text: string): string {
	return text.trim().split("\n").at(-1)?.trim() ?? "";
}

test("the launch environment matches the engine bash tool plus current session and model markers", async () => {
	let context: ExtensionContext | undefined;
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	let launchContext: BackgroundCommandContext = { cwd };
	const injected = createBackgroundCommands(
		{ sessionId: sm.getSessionId(), getContext: () => launchContext },
		executor,
	);
	const real = createBackgroundCommands({
		sessionId: sm.getSessionId(),
		getContext: () => launchContext,
	});
	const session = await makeSession(createBackgroundCommandsExtension({ service: real }), sm, [
		(pi) => {
			pi.on("session_start", (_event, ctx) => {
				context = ctx;
			});
		},
	]);
	try {
		if (!context) throw new Error("Missing context");
		session.setThinkingLevel(thinking("high"));
		const digest =
			"env | grep -v -e '^PI_PROVIDER=' -e '^PI_MODEL=' -e '^PI_REASONING_LEVEL=' -e '^_=' | sort | cksum";
		faux.setResponses([
			toolTurn(fauxToolCall("bash", { command: digest })),
			fauxAssistantMessage("NATIVE_DONE"),
		]);
		await session.prompt("Run the native digest.");
		const nativeResult = session.messages.filter((m) => m.role === "toolResult").at(-1);
		if (nativeResult?.role !== "toolResult") throw new Error("Missing native result");
		const nativeText = nativeResult.content
			.flatMap((c) => (c.type === "text" ? [c.text] : []))
			.join("");
		const nativeDigest = envDigest(nativeText.split("\n\n")[0] ?? "");
		expect(nativeDigest).toMatch(/^\d+ \d+$/);
		const sessionFile = context.sessionManager.getSessionFile();
		launchContext = {
			cwd,
			model: context.model,
			thinkingLevel: session.thinkingLevel,
			sessionFile,
		};
		const handle = real.start({ command: digest });
		const markers = real.start({
			command:
				'printf \'%s|%s|%s|%s\' "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"',
		});
		await waitFor(
			() => handle.snapshot.finishedAt !== undefined && markers.snapshot.finishedAt !== undefined,
		);
		expect(envDigest(handle.output?.text ?? "")).toBe(nativeDigest);
		expect(markers.output?.text).toBe(`${session.sessionId}|background-test|background-test|high`);
		launchContext = { cwd };
		injected.start({ command: "unmodelled" });
		expect(executor.call().options.env).toEqual({
			PI_SESSION_ID: session.sessionId,
			PI_SESSION_FILE: "",
			PI_PROVIDER: "",
			PI_MODEL: "",
			PI_REASONING_LEVEL: "",
		});
		launchContext = {
			cwd,
			model: context.model,
			thinkingLevel: session.thinkingLevel,
			exposeSessionEnvironment: false,
		};
		injected.start({ command: "private" });
		expect(Object.values(executor.call(1).options.env).every((value) => value === "")).toBe(true);
		for (const call of executor.calls) call.resolve({ exitCode: 0 });
	} finally {
		await injected.dispose();
		await session.dispose();
		await real.dispose();
	}
});

test("standalone launches read current session values at each launch and never a legacy settings prefix", async () => {
	const session = await makeSession(backgroundCommandsExtension, SessionManager.inMemory(cwd), [], {
		shellCommandPrefix: "export BG_SCOPE=legacy",
	});
	try {
		const invoke = async (expected: string) => {
			faux.setResponses([
				startCommand(
					'sleep 0.05; printf \'[%s]:%s:%s\' "$BG_SCOPE" "$PI_SESSION_ID" "$PI_REASONING_LEVEL"',
				),
				fauxAssistantMessage("ACK"),
				fauxAssistantMessage(`CHECKED_${expected}`),
			]);
			await session.prompt("Start using the current shell context.");
			await waitFor(() => JSON.stringify(session.messages).includes(`CHECKED_${expected}`));
			const last = completionMessages(session).at(-1);
			expect(JSON.stringify(last)).toContain(`[]:${session.sessionId}:${expected}`);
			await session.waitForIdle();
		};
		session.setThinkingLevel(thinking("low"));
		await invoke("low");
		session.setThinkingLevel(thinking("high"));
		await invoke("high");
	} finally {
		await session.dispose();
	}
});

test("tool and user stop display cancellation without waking an idle parent; output/list use the same records", async () => {
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	const service = createBackgroundCommands(
		{ sessionId: sm.getSessionId(), getContext: () => ({ cwd }) },
		executor,
	);
	const session = await makeSession(createBackgroundCommandsExtension({ service }), sm);
	try {
		faux.setResponses([
			toolTurn(
				fauxToolCall("background_command", {
					action: "start",
					command: "stop me",
					name: "managed",
				}),
			),
			fauxAssistantMessage("ACK"),
		]);
		await session.prompt("Start.");
		const id = service.list()[0]?.id;
		if (!id) throw new Error("Missing command");
		executor.call().options.onData(Buffer.from("recent logs"));
		faux.setResponses([
			toolTurn(fauxToolCall("background_command", { action: "list" })),
			toolTurn(fauxToolCall("background_command", { action: "output", id })),
			toolTurn(fauxToolCall("background_command", { action: "stop", id })),
			fauxAssistantMessage("STOP_REQUEST_ACK"),
		]);
		await session.prompt("Inspect and stop.");
		expect(JSON.stringify(session.messages)).toContain("recent logs");
		expect(service.find(id)?.snapshot.status).toBe("stopping");
		const calls = faux.state.callCount;
		executor.call().reject(new Error("aborted"));
		await waitFor(() => service.find(id)?.snapshot.status === "stopped");
		await waitFor(() => completionMessages(session).length === 1);
		await Bun.sleep(30);
		expect(faux.state.callCount).toBe(calls);
		expect(JSON.stringify(session.messages)).toContain("Cancelled background command");
		const second = service.start({ command: "user stop" });
		second.stop();
		executor.call(1).resolve({ exitCode: null });
		await waitFor(() => second.snapshot.status === "stopped");
		await waitFor(() => completionMessages(session).length === 2);
		await Bun.sleep(30);
		expect(faux.state.callCount).toBe(calls);
		expect(completionMessages(session)).toHaveLength(2);
	} finally {
		await session.dispose();
		await service.dispose({ timeoutMs: 10 });
	}
});

test("a detached command survives the parent-turn signal and reports after parent abort", async () => {
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	const service = createBackgroundCommands(
		{ sessionId: sm.getSessionId(), getContext: () => ({ cwd }) },
		executor,
	);
	const session = await makeSession(createBackgroundCommandsExtension({ service }), sm);
	try {
		faux.setResponses([
			startCommand("survive"),
			async () => {
				await Bun.sleep(150);
				return fauxAssistantMessage("SLOW_ACK");
			},
			fauxAssistantMessage("AFTER_ABORT_COMPLETION"),
		]);
		const callsBefore = faux.state.callCount;
		const prompted = session.prompt("Start and continue working.");
		await waitFor(() => executor.calls.length > 0);
		await waitFor(() => faux.state.callCount >= callsBefore + 2);
		await session.abort();
		await prompted;
		expect(executor.call().options.signal.aborted).toBe(false);
		executor.call().resolve({ exitCode: 0 });
		await waitFor(() => JSON.stringify(session.messages).includes("AFTER_ABORT_COMPLETION"));
	} finally {
		await session.dispose();
		await service.dispose({ timeoutMs: 10 });
	}
});

test("standalone shutdown kills owned process trees silently", async () => {
	const session = await makeSession();
	const heartbeat = join(cwd, "descendant-heartbeat");
	const beats = () => (existsSync(heartbeat) ? statSync(heartbeat).size : 0);
	let disposed = false;
	try {
		faux.setResponses([
			startCommand(`sh -c '(while :; do printf . >> "${heartbeat}"; sleep 0.1; done) & wait'`),
			fauxAssistantMessage("ACK"),
			fauxAssistantMessage("MUST_NOT_WAKE"),
		]);
		await session.prompt("Start until shutdown.");
		await waitFor(() => beats() > 0, 5000);
		const calls = faux.state.callCount;
		const messages = session.messages;
		await session.dispose();
		disposed = true;
		const deadline = Date.now() + 10_000;
		let seen = beats();
		let quietSince = Date.now();
		while (Date.now() - quietSince < 1500) {
			if (Date.now() > deadline) throw new Error("Descendant outlived session shutdown");
			await Bun.sleep(50);
			if (beats() !== seen) {
				seen = beats();
				quietSince = Date.now();
			}
		}
		expect(faux.state.callCount).toBe(calls);
		expect(JSON.stringify(messages)).not.toContain(BACKGROUND_COMMAND_COMPLETION_MESSAGE);
		expect(JSON.stringify(session.messages)).not.toContain(BACKGROUND_COMMAND_COMPLETION_MESSAGE);
	} finally {
		if (!disposed) await session.dispose();
	}
}, 20_000);

test("deletion tombstones defer bounded completion messages until rollback, without a resource reload", async () => {
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	let canDeliver = false;
	const service = createBackgroundCommands(
		{
			sessionId: sm.getSessionId(),
			getContext: () => ({ cwd }),
			canDeliverCompletion: () => canDeliver,
		},
		executor,
	);
	const session = await makeSession(createBackgroundCommandsExtension({ service }), sm);
	try {
		const command = service.start({ command: "x".repeat(64000), name: "bounded" });
		executor.call().options.onData(Buffer.from("🦊".repeat(20000)));
		executor.call().resolve({ exitCode: 0 });
		await waitFor(() => command.snapshot.status === "completed");
		await macrotask();
		expect(session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
		faux.setResponses([fauxAssistantMessage("AFTER_ROLLBACK")]);
		canDeliver = true;
		service.flushCompletions();
		await waitFor(() => JSON.stringify(session.messages).includes("AFTER_ROLLBACK"));
		const message = completionMessages(session)[0];
		if (message?.role !== "custom" || typeof message.content !== "string")
			throw new Error("Missing completion");
		expect(Buffer.byteLength(message.content)).toBeLessThan(5000);
		expect(message.content).toContain("truncated");
		expect(message.content).not.toContain("�");
		expect(JSON.stringify(message)).not.toContain("x".repeat(64000));
		await session.waitForIdle();
		service.flushCompletions();
		await macrotask();
		expect(session.messages.filter((m) => m.role === "custom")).toHaveLength(1);
	} finally {
		await session.dispose();
		await service.dispose({ timeoutMs: 10 });
	}
});

test("tool actions reject cross-action inputs and unknown or foreign identities", async () => {
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	const service = createBackgroundCommands(
		{ sessionId: sm.getSessionId(), getContext: () => ({ cwd }) },
		executor,
	);
	const session = await makeSession(createBackgroundCommandsExtension({ service }), sm);
	const other = createBackgroundCommands(
		{ sessionId: "other", getContext: () => ({ cwd }) },
		executor,
	);
	const foreign = other.start({ command: "foreign" });
	try {
		for (const input of [
			{ action: "list", command: "not accepted" },
			{ action: "stop", command: "must not create", id: foreign.id },
			{ action: "output", id: foreign.id },
			{ action: "stop", id: foreign.id },
			{ action: "stop", id: "../private.log" },
			{ action: "start" },
			{ action: "start", command: "x", cwd: "/tmp" },
			{ action: "start", command: "x", env: { DANGER: "yes" } },
			{ action: "output", id: "bogus", path: "/etc/passwd" },
			{ action: "stop", pid: 123 },
		]) {
			faux.setResponses([
				toolTurn(fauxToolCall("background_command", input)),
				fauxAssistantMessage("HANDLED"),
			]);
			await session.prompt("Try an invalid call.");
			const last = session.messages.filter((m) => m.role === "toolResult").at(-1);
			expect(last).toMatchObject({ isError: true });
			expect(service.list()).toEqual([]);
			expect(executor.calls).toHaveLength(1);
		}
		expect(foreign.snapshot.status).toBe("running");
		expect(executor.call().options.signal.aborted).toBe(false);
	} finally {
		executor.call().resolve({ exitCode: 0 });
		await session.dispose();
		await service.dispose();
		await other.dispose();
	}
});

function macrotask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function commandDeliveries(session: AgentSession) {
	return session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" &&
			entry.customType === BACKGROUND_COMMAND_COMPLETION_MESSAGE &&
			typeof entry.details === "object" &&
			entry.details !== null &&
			"delivery" in entry.details
				? [entry.details.delivery]
				: [],
		);
}

function countSettles(session: AgentSession) {
	const counter = { settles: 0 };
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "agent_end" && event.isTerminal) counter.settles++;
	});
	return counter;
}

async function injected(canDeliverCompletion?: () => boolean) {
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	const service = createBackgroundCommands(
		{ sessionId: sm.getSessionId(), getContext: () => ({ cwd }) },
		executor,
	);
	const session = await makeSession(
		createBackgroundCommandsExtension({
			service,
			...(canDeliverCompletion ? { canDeliverCompletion } : {}),
		}),
		sm,
	);
	const finish = async (index: number, text: string, exitCode = 0) => {
		executor.call(index).options.onData(Buffer.from(text));
		executor.call(index).resolve({ exitCode });
		await waitFor(() => service.list()[index]?.finishedAt !== undefined);
		await macrotask();
	};
	const close = async () => {
		await session.dispose();
		await service.dispose();
	};
	return { executor, service, session, finish, close };
}

async function waitForListed(session: AgentSession, status: string): Promise<void> {
	const tool = session.getToolByName("background_command");
	if (!tool) throw new Error("Missing background_command");
	const deadline = Date.now() + 10_000;
	for (;;) {
		const listed = await tool.execute("probe", { action: "list" });
		if (JSON.stringify(listed.content).includes(`: ${status}`)) return;
		if (Date.now() > deadline) throw new Error(`No command reached ${status}`);
		await Bun.sleep(20);
	}
}

test("a command finishing during a tool turn reaches the next request of the same run", async () => {
	const { service, session, finish, close } = await injected();
	const counter = countSettles(session);
	let sawReport = false;
	try {
		faux.setResponses([
			startCommand("work"),
			async () => {
				await finish(0, "CMD_DONE");
				return toolTurn(fauxToolCall("background_command", { action: "list" }));
			},
			(context) => {
				sawReport = JSON.stringify(context.messages).includes("CMD_DONE");
				return fauxAssistantMessage("DONE");
			},
		]);
		await session.prompt("Start and keep working.");
		await session.waitForIdle();
		await macrotask();
		expect(sawReport).toBe(true);
		expect(counter.settles).toBe(1);
		expect(commandDeliveries(session)).toEqual(["run"]);
		expect(service.list()[0]?.status).toBe("completed");
	} finally {
		await close();
	}
});

test("a command deliverable only once a tool returns joins the request right after its batch", async () => {
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	const service = createBackgroundCommands(
		{ sessionId: sm.getSessionId(), getContext: () => ({ cwd }) },
		executor,
	);
	let open = false;
	const stepStarted = Promise.withResolvers<void>();
	const startTurnHandled = Promise.withResolvers<void>();
	const startTurn = (event: TurnEndEvent) =>
		event.toolResults.some((result) => result.toolName === "background_command");
	const slowTurnEnds: ExtensionFactory = (pi) => {
		pi.on("turn_end", async (event) => {
			if (startTurn(event)) await stepStarted.promise;
			else await Bun.sleep(50);
		});
	};
	const gatedStep: ExtensionFactory = (pi) => {
		pi.on("turn_end", (event) => {
			if (startTurn(event)) startTurnHandled.resolve();
		});
		pi.registerTool({
			name: "gated_step",
			label: "Gated step",
			description: "Finishes the background command, then opens the delivery gate",
			parameters: z.object({}),
			loadMode: "essential",
			async execute() {
				stepStarted.resolve();
				await startTurnHandled.promise;
				executor.call(0).options.onData(Buffer.from("BATCH_DONE"));
				executor.call(0).resolve({ exitCode: 0 });
				await waitFor(() => service.list()[0]?.finishedAt !== undefined);
				await macrotask();
				open = true;
				return { content: [{ type: "text", text: "GATED_RESULT" }], details: {} };
			},
		});
	};
	const session = await makeSession(slowTurnEnds, sm, [
		createBackgroundCommandsExtension({ service, canDeliverCompletion: () => open }),
		gatedStep,
	]);
	let sawReport = false;
	try {
		faux.setResponses([
			startCommand("work"),
			toolTurn(fauxToolCall("gated_step", {})),
			(context) => {
				sawReport = JSON.stringify(context.messages).includes("BATCH_DONE");
				return fauxAssistantMessage("DONE");
			},
			fauxAssistantMessage("LATE_ASIDE"),
		]);
		const before = faux.state.callCount;
		await session.prompt("Start, then take the gated step.");
		await session.waitForIdle();
		await macrotask();
		expect(sawReport).toBe(true);
		expect(faux.state.callCount - before).toBe(3);
		expect(commandDeliveries(session)).toEqual(["run"]);
		const tail = session.messages.slice(-3);
		expect(tail.map((m) => m.role)).toEqual(["toolResult", "custom", "assistant"]);
		expect(JSON.stringify(tail[0])).toContain("GATED_RESULT");
		expect(JSON.stringify(session.messages)).not.toContain("LATE_ASIDE");
	} finally {
		await session.dispose();
		await service.dispose();
	}
});

test("a finished command whose output the model read is never reported again", async () => {
	const { service, session, finish, close } = await injected();
	try {
		faux.setResponses([
			startCommand("work"),
			async () => {
				await finish(0, "CMD_OUTPUT", 3);
				return toolTurn(
					fauxToolCall("background_command", { action: "output", id: service.list()[0]?.id ?? "" }),
				);
			},
			fauxAssistantMessage("DONE"),
			fauxAssistantMessage("ALREADY_SEEN"),
		]);
		const before = faux.state.callCount;
		await session.prompt("Start, then read the output.");
		await session.waitForIdle();
		await macrotask();
		expect(commandDeliveries(session)).toEqual([]);
		expect(faux.state.callCount - before).toBe(3);
		const read = session.messages.filter((m) => m.role === "toolResult").at(-1);
		expect(JSON.stringify(read)).toContain("error, exit code 3");
		expect(JSON.stringify(read)).toContain("Command exited with code 3");
	} finally {
		await close();
	}
});

test("a host read of finished output never suppresses the command's report", async () => {
	let allowed = false;
	const { service, session, finish, close } = await injected(() => allowed);
	try {
		faux.setResponses([
			startCommand("work"),
			fauxAssistantMessage("ACK"),
			fauxAssistantMessage("SEEN"),
		]);
		await session.prompt("Start.");
		await finish(0, "HOST_READ");
		const id = service.list()[0]?.id ?? "";
		expect(service.find(id)?.output?.text).toContain("HOST_READ");
		allowed = true;
		service.flushCompletions();
		await waitFor(() => !session.isStreaming && commandDeliveries(session).length === 1);
		expect(commandDeliveries(session)).toEqual(["wake"]);
	} finally {
		await close();
	}
});

test("commands released to an idle parent together wake exactly one run", async () => {
	let allowed = false;
	const { service, session, finish, close } = await injected(() => allowed);
	const counter = countSettles(session);
	let reports = 0;
	try {
		faux.setResponses([
			toolTurn(
				fauxToolCall("background_command", { action: "start", command: "one" }),
				fauxToolCall("background_command", { action: "start", command: "two" }),
			),
			fauxAssistantMessage("STARTED"),
			(context) => {
				const text = JSON.stringify(context.messages);
				reports = ["FIRST_CMD", "SECOND_CMD"].filter((r) => text.includes(r)).length;
				return fauxAssistantMessage("WOKEN_ONCE");
			},
			fauxAssistantMessage("SECOND_WAKE"),
		]);
		await session.prompt("Start two.");
		await finish(0, "FIRST_CMD");
		await finish(1, "SECOND_CMD");
		expect(commandDeliveries(session)).toEqual([]);
		allowed = true;
		service.flushCompletions();
		await waitFor(() => !session.isStreaming && counter.settles === 2);
		await macrotask();
		expect(counter.settles).toBe(2);
		expect(reports).toBe(2);
		expect(commandDeliveries(session)).toEqual(["wake", "run"]);
		expect(JSON.stringify(session.messages)).not.toContain("SECOND_WAKE");
	} finally {
		await close();
	}
});

test("a command held when the user stops the parent is shown without waking it", async () => {
	const { session, finish, close } = await injected();
	const counter = countSettles(session);
	let parked = () => {};
	const parkedPromise = new Promise<void>((resolve) => {
		parked = resolve;
	});
	try {
		faux.setResponses([
			startCommand("work"),
			async (_context, options) => {
				await finish(0, "HELD_AT_STOP");
				parked();
				await new Promise((resolve) =>
					options?.signal?.addEventListener("abort", resolve, { once: true }),
				);
				return fauxAssistantMessage("ABORTED");
			},
			fauxAssistantMessage("WOKE_AFTER_STOP"),
		]);
		const run = session.prompt("Start, then get stopped.");
		await parkedPromise;
		const callsAtStop = faux.state.callCount;
		await session.abort();
		await run;
		await waitFor(() => commandDeliveries(session).length === 1);
		await macrotask();
		expect(commandDeliveries(session)).toEqual(["appended"]);
		expect(faux.state.callCount).toBe(callsAtStop);
		expect(counter.settles).toBe(1);
	} finally {
		await close();
	}
});

test("several commands held when the user stops the parent are all shown without waking it", async () => {
	const { session, finish, close } = await injected();
	const counter = countSettles(session);
	let parked = () => {};
	const parkedPromise = new Promise<void>((resolve) => {
		parked = resolve;
	});
	try {
		faux.setResponses([
			toolTurn(
				fauxToolCall("background_command", { action: "start", command: "one" }),
				fauxToolCall("background_command", { action: "start", command: "two" }),
			),
			async (_context, options) => {
				await finish(0, "FIRST_HELD");
				await finish(1, "SECOND_HELD");
				parked();
				await new Promise((resolve) =>
					options?.signal?.addEventListener("abort", resolve, { once: true }),
				);
				return fauxAssistantMessage("ABORTED");
			},
			fauxAssistantMessage("WOKE_AFTER_STOP"),
		]);
		const run = session.prompt("Start two, then get stopped.");
		await parkedPromise;
		const callsAtStop = faux.state.callCount;
		await session.abort();
		await run;
		await waitFor(() => commandDeliveries(session).length === 2);
		await macrotask();
		expect(commandDeliveries(session)).toEqual(["appended", "appended"]);
		expect(faux.state.callCount).toBe(callsAtStop);
		expect(counter.settles).toBe(1);
	} finally {
		await close();
	}
});

test("a rejected waking send keeps the wake for the retry instead of losing it", async () => {
	let allowed = false;
	let rejectWake = true;
	const executor = controlledOperations();
	const sm = SessionManager.inMemory(cwd);
	const service = createBackgroundCommands(
		{ sessionId: sm.getSessionId(), getContext: () => ({ cwd }) },
		executor,
	);
	const extension = createBackgroundCommandsExtension({
		service,
		canDeliverCompletion: () => allowed,
	});
	const session = await makeSession((pi) => {
		const sendMessage: ExtensionAPI["sendMessage"] = (message, options) => {
			if (options?.triggerTurn && rejectWake) {
				rejectWake = false;
				throw new Error("runtime unavailable");
			}
			pi.sendMessage(message, options);
		};
		return extension(
			new Proxy(pi, {
				get: (target, key, receiver) =>
					key === "sendMessage" ? sendMessage : Reflect.get(target, key, receiver),
			}),
		);
	}, sm);
	const counter = countSettles(session);
	let sawNatural = false;
	try {
		faux.setResponses([
			toolTurn(
				fauxToolCall("background_command", { action: "start", command: "natural" }),
				fauxToolCall("background_command", { action: "start", command: "stopped" }),
			),
			fauxAssistantMessage("STARTED"),
			(context) => {
				sawNatural = JSON.stringify(context.messages).includes("NATURAL_RESULT");
				return fauxAssistantMessage("WOKEN");
			},
		]);
		await session.prompt("Start two.");
		await macrotask();
		executor.call(0).options.onData(Buffer.from("NATURAL_RESULT"));
		executor.call(0).resolve({ exitCode: 0 });
		service.find(service.list()[1]?.id ?? "")?.stop();
		executor.call(1).resolve({ exitCode: null });
		await waitFor(() => service.list().every((snapshot) => snapshot.finishedAt !== undefined));
		allowed = true;
		service.flushCompletions();
		await waitFor(() => commandDeliveries(session).length === 1);
		await macrotask();
		expect(commandDeliveries(session)).toHaveLength(1);
		expect(counter.settles).toBe(1);
		service.flushCompletions();
		await waitFor(() => !session.isStreaming && counter.settles === 2);
		expect(sawNatural).toBe(true);
		expect(commandDeliveries(session)).toHaveLength(2);
	} finally {
		await session.dispose();
		await service.dispose();
	}
});

test("one factory serving two sessions keeps each session's Stop to itself", async () => {
	let allowed = false;
	const factory = createBackgroundCommandsExtension({ canDeliverCompletion: () => allowed });
	const first = await makeSession(factory);
	const second = await makeSession(factory);
	let parked = () => {};
	const parkedPromise = new Promise<void>((resolve) => {
		parked = resolve;
	});
	try {
		faux.setResponses([
			startCommand("printf HELD_IN_FIRST"),
			async (_context, options) => {
				await waitForListed(first, "completed");
				parked();
				await new Promise((resolve) =>
					options?.signal?.addEventListener("abort", resolve, { once: true }),
				);
				return fauxAssistantMessage("ABORTED");
			},
		]);
		const run = first.prompt("Start, then get stopped.");
		await parkedPromise;
		await first.abort();
		await run;
		await macrotask();
		faux.setResponses([fauxAssistantMessage("SECOND_ANSWER")]);
		await second.prompt("An unrelated question in another chat.");
		await second.waitForIdle();
		const calls = faux.state.callCount;
		faux.setResponses([fauxAssistantMessage("FIRST_WOKE")]);
		allowed = true;
		await runner(first).emit({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
		await waitFor(() => commandDeliveries(first).length === 1);
		await macrotask();
		expect(commandDeliveries(first)).toEqual(["appended"]);
		expect(faux.state.callCount).toBe(calls);
		expect(JSON.stringify(first.messages)).not.toContain("FIRST_WOKE");
	} finally {
		await first.dispose();
		await second.dispose();
	}
}, 20_000);
