import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import defaultFactory, {
	ASK_ACK_TEXT,
	ASK_UNAVAILABLE_TEXT,
	type AskRequest,
	type AskUserQuestionArgs,
	type AskUserQuestionExtensionOptions,
	createAskUserQuestionExtension,
	DEFAULT_DESCRIPTION,
	DEFAULT_PROMPT_GUIDELINES,
} from "./index.ts";
import {
	DISCARDED_CALL_REASON,
	NOT_MODEL_CALL_REASON,
	promptGuidelinesSection,
} from "./src/extension.ts";

type ExecResult = {
	content: { type: string; text: string }[];
	details: unknown;
	terminate?: boolean;
};

interface CapturedTool {
	name: string;
	description: string;
	loadMode?: string;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ExecResult>;
}

type Handler = (event: Record<string, unknown>) => unknown;

function load(options?: AskUserQuestionExtensionOptions, activeTools = ["ask_user_question"]) {
	let tool: CapturedTool | undefined;
	const handlers = new Map<string, Handler>();
	const pi = {
		registerTool: (definition: CapturedTool) => {
			tool = definition;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	(options ? createAskUserQuestionExtension(options) : defaultFactory)(pi);
	if (!tool) throw new Error("the extension registered no tool");
	const emit = (event: string, payload: Record<string, unknown>) => handlers.get(event)?.(payload);
	const systemPrompt = () => emit("before_agent_start", { systemPrompt: ["base"] });
	const toolCall = (toolName: string, toolCallId: string) =>
		emit("tool_call", { type: "tool_call", toolName, toolCallId, input: {} });
	return { tool, emit, systemPrompt, toolCall };
}

const args: AskUserQuestionArgs = {
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

const text = (result: ExecResult): string => result.content.map((block) => block.text).join("");

describe("ask_user_question extension", () => {
	test("registers an essential ask_user_question and appends the default guidelines to the system prompt", () => {
		const { tool, systemPrompt } = load();
		expect(tool.name).toBe("ask_user_question");
		expect(tool.loadMode).toBe("essential");
		expect(tool.description).toBe(DEFAULT_DESCRIPTION);
		expect(systemPrompt()).toEqual({
			systemPrompt: ["base", promptGuidelinesSection(DEFAULT_PROMPT_GUIDELINES)],
		});
		expect(load(undefined, ["read"]).systemPrompt()).toBeUndefined();
	});

	test("guidance replaces the description and guidelines", () => {
		const { tool, systemPrompt } = load({
			guidance: { description: "Host wording", promptGuidelines: ["one"] },
		});
		expect(tool.description).toBe("Host wording");
		expect(systemPrompt()).toEqual({
			systemPrompt: ["base", "Guidelines for ask_user_question:\n- one"],
		});
	});

	test("the batch hooks keep the first ask as the batch's only executed tool call", () => {
		const { emit, toolCall } = load();
		const message = {
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "read-1", name: "read" },
				{ type: "toolCall", id: "ask-1", name: "ask_user_question" },
				{ type: "toolCall", id: "ask-2", name: "ask_user_question" },
			],
		};
		expect(emit("assistant_message", { message })).toBeUndefined();
		expect(toolCall("read", "read-1")).toEqual({ block: true, reason: DISCARDED_CALL_REASON });
		expect(toolCall("ask_user_question", "ask-2")).toEqual({
			block: true,
			reason: DISCARDED_CALL_REASON,
		});
		expect(toolCall("ask_user_question", "ask-1")).toBeUndefined();
		emit("assistant_message", { message: { role: "user", content: "hi" } });
		expect(toolCall("read", "read-2")).toBeUndefined();
	});

	test("the assistant_message hook announces only the executable ask call it keeps", () => {
		const announced: string[] = [];
		const { emit } = load({ announce: (toolCallId) => announced.push(toolCallId) });
		const batch = (stopReason: string) => ({
			role: "assistant",
			stopReason,
			content: [
				{ type: "toolCall", id: "ask-1", name: "ask_user_question" },
				{ type: "toolCall", id: "ask-2", name: "ask_user_question" },
			],
		});
		emit("assistant_message", { message: batch("toolUse") });
		for (const stopReason of ["length", "error", "aborted"])
			emit("assistant_message", { message: batch(stopReason) });
		emit("assistant_message", { message: { role: "user", content: "hi" } });
		expect(announced).toEqual(["ask-1"]);
	});

	test("an ask the model did not issue directly, such as an eval script's, is blocked", () => {
		const { toolCall } = load();
		expect(toolCall("ask_user_question", "js-ask_user_question-1")).toEqual({
			block: true,
			reason: NOT_MODEL_CALL_REASON,
		});
	});

	test("without UI the built-in asker reports that it cannot ask", async () => {
		const { tool } = load();
		const result = await tool.execute("tc", args, undefined, undefined, { hasUI: false });
		expect(text(result)).toBe(ASK_UNAVAILABLE_TEXT);
		expect(result.details).toEqual({ answers: [], cancelled: true });
		expect(result.terminate).toBeUndefined();
	});

	test("a malformed questionnaire is rejected before anyone is asked", async () => {
		let asked = false;
		const { tool } = load({
			ask: async () => {
				asked = true;
				return { kind: "deferred" };
			},
		});
		const result = await tool.execute("tc", { questions: [] }, undefined, undefined, {});
		expect(text(result)).toContain("At least one question");
		expect(asked).toBe(false);
	});

	test("an injected asker receives the call and its outcome becomes the tool result", async () => {
		const requests: AskRequest[] = [];
		const signal = new AbortController().signal;
		const ctx = { hasUI: false, mode: "rpc" };
		const { tool } = load({
			ask: async (request) => {
				requests.push(request);
				return {
					kind: "answered",
					result: {
						cancelled: false,
						answers: [
							{ questionIndex: 0, question: "Which library?", kind: "option", answer: "luxon" },
						],
					},
				};
			},
		});
		const result = await tool.execute("tc-7", args, signal, undefined, ctx);
		expect(requests).toEqual([{ toolCallId: "tc-7", args, signal, ctx: ctx as never }]);
		expect(text(result)).toContain('"Which library?"="luxon"');
	});

	test("a deferred outcome ends the turn with the canonical ack", async () => {
		const { tool } = load({ ask: async () => ({ kind: "deferred" }) });
		const result = await tool.execute("tc", args, undefined, undefined, { hasUI: true });
		expect(text(result)).toBe(ASK_ACK_TEXT);
		expect(result.details).toEqual({ kind: "ack" });
		expect(result.terminate).toBe(true);
	});

	test("an asker's rejection propagates so pi records a tool error", async () => {
		const { tool } = load({
			ask: async () => {
				throw new Error("stopped");
			},
		});
		await expect(tool.execute("tc", args, undefined, undefined, { hasUI: true })).rejects.toThrow(
			"stopped",
		);
	});

	test("outside the terminal the built-in asker walks the questions with dialogs", async () => {
		const { tool } = load();
		const ui = {
			select: async (_title: string, choices: string[]) => choices[1],
			input: async () => undefined,
		};
		const result = await tool.execute("tc", args, undefined, undefined, {
			hasUI: true,
			mode: "rpc",
			ui,
		});
		expect(text(result)).toContain('"Which library?"="luxon"');
	});
});
