import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_TOOL_RESULT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionUIContext,
	type ExtensionUISelectItem,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
	createFauxModelRegistry,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";
import { createAskUserQuestionExtension } from "../index.ts";
import { DISCARDED_CALL_REASON } from "./extension.ts";

const faux = fauxProvider({ provider: "faux-ask", tokensPerSecond: 100_000 });

const args = {
	questions: [
		{
			question: "Which library?",
			header: "Lib",
			options: [
				{ label: "date-fns", description: "small" },
				{ label: "luxon", description: "rich" },
			],
		},
	],
};

let root: string;
let agentDirIsolation: IsolatedAgentDir | undefined;
const sessions: AgentSession[] = [];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-ask-session-"));
	agentDirIsolation = isolateAgentDir(mkdtempSync(join(root, "agent-")));
});

afterAll(async () => {
	for (const session of sessions) await session.dispose();
	agentDirIsolation?.restore();
	rmSync(root, { recursive: true, force: true });
});

function uiContext(provided: Partial<ExtensionUIContext>): ExtensionUIContext {
	return new Proxy(provided, {
		get: (target, key) =>
			key in target ? target[key as keyof ExtensionUIContext] : () => undefined,
	}) as ExtensionUIContext;
}

async function openSession(
	ui: Partial<ExtensionUIContext>,
	hostEndsRuns = false,
): Promise<AgentSession> {
	const settings = Settings.isolated({});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const model = registerFaux(modelRegistry, faux);
	const cwd = mkdtempSync(join(root, "cwd-"));
	let opened: AgentSession | undefined;
	const { session } = await createAgentSession({
		cwd,
		agentDir: agentDirIsolation?.dir ?? cwd,
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(cwd),
		extensions: [
			createAskUserQuestionExtension(
				hostEndsRuns
					? { endRun: () => opened?.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON) }
					: {},
			),
		],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: true,
	});
	opened = session;
	sessions.push(session);
	await initializeExtensions(session, {
		mode: "rpc",
		uiContext: uiContext(ui),
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: (error) => {
			throw new Error(error.error);
		},
	});
	return session;
}

const label = (item: ExtensionUISelectItem | undefined) =>
	typeof item === "string" ? item : item?.label;

async function run(session: AgentSession, text: string): Promise<void> {
	await session.prompt(text);
	await session.waitForIdle();
}

const askTurn = (extra: ReturnType<typeof fauxToolCall>[] = []) =>
	fauxAssistantMessage([...extra, fauxToolCall("ask_user_question", args, { id: "ask-1" })], {
		stopReason: "toolUse",
	});

describe("ask_user_question in a real omp session", () => {
	test("an answer goes back to the model and the run continues", async () => {
		faux.setResponses([askTurn(), fauxAssistantMessage("Going with luxon.")]);
		const calls = faux.state.callCount;
		const session = await openSession({ select: async (_title, choices) => label(choices[1]) });
		await run(session, "Pick a date library.");
		expect(faux.state.callCount - calls).toBe(2);
		const result = session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(result?.content)).toContain('\\"Which library?\\"=\\"luxon\\"');
		const last = session.messages.at(-1);
		expect(last?.role).toBe("assistant");
	});

	test("choosing to chat ends the run without another model call when the host can end runs", async () => {
		faux.setResponses([askTurn(), fauxAssistantMessage("should not be requested")]);
		const calls = faux.state.callCount;
		const session = await openSession(
			{ select: async (_title, choices) => label(choices.at(-1)) },
			true,
		);
		await run(session, "Pick a date library.");
		expect(faux.state.callCount - calls).toBe(1);
		const last = session.messages.at(-1);
		expect(last?.role).toBe("toolResult");
		expect(last?.role === "toolResult" && last.details).toEqual({ kind: "ack" });
	});

	test("without a host that ends runs, omp asks the model once more after a deferral", async () => {
		faux.setResponses([askTurn(), fauxAssistantMessage("Waiting for your reply.")]);
		const calls = faux.state.callCount;
		const session = await openSession({ select: async (_title, choices) => label(choices.at(-1)) });
		await run(session, "Pick a date library.");
		expect(faux.state.callCount - calls).toBe(2);
		const result = session.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" && result.details).toEqual({ kind: "ack" });
	});

	test("sibling tool calls of an ask are not executed and are told to re-issue", async () => {
		faux.setResponses([
			askTurn([fauxToolCall("read", { path: "README.md" }, { id: "read-1" })]),
			fauxAssistantMessage("ok"),
		]);
		const session = await openSession({ select: async (_title, choices) => label(choices[0]) });
		await run(session, "Pick a date library.");
		const results = session.messages.flatMap((message) =>
			message.role === "toolResult" ? [message] : [],
		);
		const read = results.find((message) => message.toolCallId === "read-1");
		expect(read?.isError).toBe(true);
		expect(JSON.stringify(read?.content)).toContain(DISCARDED_CALL_REASON);
		const ask = results.find((message) => message.toolCallId === "ask-1");
		expect(ask?.isError).toBe(false);
		expect(JSON.stringify(ask?.content)).toContain('\\"Which library?\\"=\\"date-fns\\"');
	});
});
