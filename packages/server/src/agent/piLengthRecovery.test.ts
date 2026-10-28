import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	type ExtensionAPI,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
	createFauxCore,
	createFauxModelRegistry,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";

const CONTEXT_WINDOW = 100_000;
const SEEDED_TURN_TOKENS = 20_000;

const root = mkdtempSync(join(tmpdir(), "thinkrail-pi-length-"));
let agentDir: IsolatedAgentDir | undefined;
let sequence = 0;

beforeAll(() => {
	agentDir = isolateAgentDir(join(root, "agent"));
});

afterAll(() => {
	agentDir?.restore();
	rmSync(root, { recursive: true, force: true });
});

function seedHistory(manager: SessionManager, model: Model<Api>): void {
	for (let turn = 0; turn < 3; turn++) {
		manager.appendMessage({
			role: "user",
			content: `old request ${turn} ${"y".repeat(SEEDED_TURN_TOKENS * 4)}`,
			timestamp: turn * 10 + 1,
		});
		manager.appendMessage({
			...fauxAssistantMessage(`old answer ${turn}`, { timestamp: turn * 10 + 2 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
	}
}

async function waitFor(read: () => boolean, ms = 10_000): Promise<void> {
	const until = Date.now() + ms;
	while (!read()) {
		if (Date.now() > until) throw new Error("condition timed out");
		await Bun.sleep(10);
	}
}

const isTerminalEnd = (event: AgentSessionEvent): boolean =>
	event.type === "agent_end" && event.isTerminal === true;

async function runRecoveryScenario(
	responses: FauxResponseStep[],
	seed: (manager: SessionManager, model: Model<Api>) => void = seedHistory,
): Promise<{ events: AgentSessionEvent[]; callCount: number; finalText: string | undefined }> {
	const settings = Settings.isolated({
		"compaction.enabled": true,
		"compaction.methodOrder": ["soft"],
	});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const faux = createFauxCore({
		provider: `length-probe-${++sequence}`,
		models: [
			{ id: "length-probe", input: ["text"], contextWindow: CONTEXT_WINDOW, maxTokens: 4000 },
		],
		tokensPerSecond: 1_000_000,
		tokenSize: { min: 4000, max: 4000 },
	});
	faux.setResponses(responses);
	const model = registerFaux(modelRegistry, faux);
	const summarize = (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "Compacted for context recovery.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
	};
	const sessionManager = SessionManager.inMemory(root);
	seed(sessionManager, model);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager,
		extensions: [summarize],
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
		mode: "rpc",
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: (error) => {
			throw new Error(error.error);
		},
	});
	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => events.push(event));
	try {
		await session.prompt("Continue the work.");
		await waitFor(() => events.some(isTerminalEnd));
		await session.waitForIdle();
		const finalAssistant = session.messages.findLast((message) => message.role === "assistant");
		const firstBlock = finalAssistant?.role === "assistant" ? finalAssistant.content[0] : undefined;
		return {
			events,
			callCount: faux.state.callCount,
			finalText: firstBlock?.type === "text" ? firstBlock.text : undefined,
		};
	} finally {
		unsubscribe();
		await session.dispose();
	}
}

const compactionStarts = (events: AgentSessionEvent[]) =>
	events.flatMap((event) => (event.type === "auto_compaction_start" ? [event.reason] : []));

const compactionRetries = (events: AgentSessionEvent[]) =>
	events.flatMap((event) => (event.type === "auto_compaction_end" ? [event.willRetry] : []));

const warnings = (events: AgentSessionEvent[]) =>
	events.flatMap((event) =>
		event.type === "notice" && event.level === "warning" ? [event.message] : [],
	);

const RECOVERY_STOPS = [
	{
		name: "a premature length stop",
		response: { stopReason: "length" },
		recurrence: {
			retries: [true],
			warning: "output limit (",
		},
	},
	{
		name: "a provider context overflow",
		response: {
			stopReason: "error",
			errorMessage: "400 invalid_request_error: prompt is too long: 120000 tokens > 100000 maximum",
		},
		recurrence: {
			retries: [true, false],
			warning: "Compaction freed too little context to make progress",
		},
	},
] as const;

test.each(RECOVERY_STOPS)("omp compacts and retries $name before settling", async ({
	response,
}) => {
	const result = await runRecoveryScenario([
		fauxAssistantMessage("incomplete", response),
		fauxAssistantMessage("completed response"),
	]);

	expect(result.callCount).toBe(2);
	expect(result.finalText).toBe("completed response");
	expect(result.events.filter((event) => event.type === "agent_start")).toHaveLength(2);
	expect(compactionStarts(result.events)).toEqual(["overflow"]);
	expect(compactionRetries(result.events)).toEqual([true]);
	expect(result.events.filter(isTerminalEnd)).toHaveLength(1);
	expect(result.events.at(-1)?.type).toBe("agent_end");
});

test("a restored truncated call is replayed only together with its error result, never dangling", async () => {
	let replayed: string[] = [];
	const result = await runRecoveryScenario(
		[
			(context) => {
				replayed = context.messages.map((message) =>
					message.role === "assistant"
						? `assistant:${message.stopReason}`
						: message.role === "toolResult"
							? `toolResult:${message.toolCallId}:${message.isError}`
							: message.role,
				);
				return fauxAssistantMessage("recovered");
			},
		],
		(manager, model) => {
			manager.appendMessage({ role: "user", content: "check status", timestamp: 1 });
			manager.appendMessage({
				...fauxAssistantMessage([fauxToolCall("bash", { command: "echo" }, { id: "truncated" })], {
					stopReason: "length",
					timestamp: 2,
				}),
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "truncated",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "Not executed: output token limit reached." }],
				timestamp: 3,
			});
		},
	);
	expect(replayed).toEqual(["user", "assistant:length", "toolResult:truncated:true", "user"]);
	expect(result.finalText).toBe("recovered");
	expect(result.events.at(-1)?.type).toBe("agent_end");
	expect(result.events.filter(isTerminalEnd)).toHaveLength(1);
});

test.each(
	RECOVERY_STOPS,
)("omp stops after one compact-and-retry attempt when $name recurs", async ({
	response,
	recurrence,
}) => {
	const result = await runRecoveryScenario([
		fauxAssistantMessage("first incomplete", response),
		() =>
			fauxAssistantMessage("second incomplete", {
				...response,
				timestamp: Date.now() + 60_000,
			}),
		fauxAssistantMessage("never requested"),
	]);

	expect(result.callCount).toBe(2);
	expect(compactionRetries(result.events)).toEqual([...recurrence.retries]);
	expect(warnings(result.events).some((message) => message.includes(recurrence.warning))).toBe(
		true,
	);
	expect(result.events.filter(isTerminalEnd)).toHaveLength(1);
	expect(result.events.at(-1)?.type).toBe("agent_end");
});
