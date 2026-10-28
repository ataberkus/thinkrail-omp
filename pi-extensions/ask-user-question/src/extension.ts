import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import {
	ASK_UNAVAILABLE_TEXT,
	ASK_USER_QUESTION_TOOL_NAME,
	type AskUserQuestionArgs,
	type AskUserQuestionAsker,
	executableAskCallIds,
	isolateAskUserQuestionBatch,
	MAX_OPTIONS,
	MIN_OPTIONS,
	outcomeResult,
	textResult,
	validateQuestionnaire,
} from "./core.ts";
import { askWithDialogs } from "./dialogs.ts";
import { AskUserQuestionSchema } from "./schema.ts";
import { askInTerminal, renderAskCall, renderAskResult } from "./tui.ts";

export interface AskUserQuestionGuidance {
	description?: string;
	promptGuidelines?: readonly string[];
}

export interface AskUserQuestionExtensionOptions {
	ask?: AskUserQuestionAsker;
	announce?: (toolCallId: string) => void;
	guidance?: AskUserQuestionGuidance;
	endRun?: (toolCallId: string) => void;
}

export const DEFAULT_DESCRIPTION = `Ask the user one or more structured, multiple-choice questions during execution, instead of guessing. Use when:
1. The request is underspecified and you cannot proceed without a concrete decision.
2. You need a user preference, requirement, or a direction/implementation choice.

Calling this tool PAUSES EXECUTION until the user answers: the questions are shown as an interactive questionnaire (one page per question when there are several), and the user's answers arrive as this tool's result. Do not continue working on the blocked task or assume an answer while the tool is pending. The user may instead choose to discuss the questions in chat — then this turn ends and their free-form reply arrives as the next user message. Notes:
- Every question also gets an "Other" option with a free-text field, and the user can always Skip the whole questionnaire (you are told they declined) — do NOT author "Other"-style, free-text, or escape options yourself (reserved labels are rejected).
- Set multiSelect: true when several answers are valid; the user may combine checked options with their own typed answer.
- If you recommend one option, make it FIRST, append "(Recommended)" to its label, and set its recommendedReason to one short sentence on why you recommend it over the alternatives (shown under the option).
- Use options[].preview (markdown) for concrete artifacts to compare side-by-side (code, ASCII mockups, configs). Single-select only.
- One call = one round: ask every question you can ask now in a single call — never split independent questions across back-to-back calls. A question that depends on another question's answer waits for a later round; ask follow-up rounds until no decision is left assumed.
- Call ask_user_question as the only tool in the assistant response; other tool calls in that response are discarded and can be re-issued after the answer.
- The user may answer only some questions; unanswered ones are reported as declined.`;

export const DEFAULT_PROMPT_GUIDELINES: readonly string[] = [
	`Call ask_user_question whenever the request is ambiguous and a concrete decision is needed — one call is one round holding every question answerable now (dependent questions wait for the next round), with ${MIN_OPTIONS}-${MAX_OPTIONS} options each. The call blocks until its result contains the user's answers.`,
	"Every option needs a concise label (1-5 words) and a description of what it means / its trade-off.",
	'Recommend by putting the option first with "(Recommended)" appended and setting its recommendedReason to one short sentence (shown under the option) on why you recommend it over the alternatives; the user can always type a custom answer or skip the questionnaire.',
	"Call ask_user_question as the only tool in the assistant response; continue with other tools after the answer.",
];

export const DISCARDED_CALL_REASON = `Not executed: ${ASK_USER_QUESTION_TOOL_NAME} must be the only tool call in its assistant response. Re-issue this call after the user answers.`;
export const NOT_MODEL_CALL_REASON = `${ASK_USER_QUESTION_TOOL_NAME} can only be called directly by the model, as the only tool call in its response.`;

const askWithBuiltInUi: AskUserQuestionAsker = (request) =>
	request.ctx.mode === "tui" ? askInTerminal(request) : askWithDialogs(request);

function toolCallIds(message: { role: string }): string[] {
	const content = (message as { content?: unknown }).content;
	if (message.role !== "assistant" || !Array.isArray(content)) return [];
	return content.flatMap((block: { type?: unknown; id?: unknown }) =>
		block?.type === "toolCall" && typeof block.id === "string" ? [block.id] : [],
	);
}

export function promptGuidelinesSection(guidelines: readonly string[]): string {
	return [
		`Guidelines for ${ASK_USER_QUESTION_TOOL_NAME}:`,
		...guidelines.map((line) => `- ${line}`),
	].join("\n");
}

export function createAskUserQuestionExtension(
	options: AskUserQuestionExtensionOptions = {},
): ExtensionFactory {
	const ask = options.ask ?? askWithBuiltInUi;
	const guidance = options.guidance ?? {};
	const promptGuidelines = [...(guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES)];
	return (pi: ExtensionAPI): void => {
		const kept = new Set<string>();
		const discarded = new Set<string>();
		pi.on("assistant_message", (event) => {
			const isolated = isolateAskUserQuestionBatch(event.message) ?? event.message;
			const executable = executableAskCallIds(isolated);
			for (const toolCallId of executable) {
				kept.add(toolCallId);
				options.announce?.(toolCallId);
			}
			const remaining = new Set(toolCallIds(isolated));
			for (const toolCallId of toolCallIds(event.message))
				if (!remaining.has(toolCallId)) discarded.add(toolCallId);
		});
		pi.on("tool_call", (event) => {
			if (discarded.delete(event.toolCallId)) return { block: true, reason: DISCARDED_CALL_REASON };
			if (event.toolName !== ASK_USER_QUESTION_TOOL_NAME || kept.delete(event.toolCallId))
				return undefined;
			return { block: true, reason: NOT_MODEL_CALL_REASON };
		});
		pi.on("before_agent_start", (event) => {
			if (promptGuidelines.length === 0) return undefined;
			if (!pi.getActiveTools().includes(ASK_USER_QUESTION_TOOL_NAME)) return undefined;
			return { systemPrompt: [...event.systemPrompt, promptGuidelinesSection(promptGuidelines)] };
		});
		pi.registerTool({
			name: ASK_USER_QUESTION_TOOL_NAME,
			label: "Ask User Question",
			description: guidance.description ?? DEFAULT_DESCRIPTION,
			parameters: AskUserQuestionSchema,
			loadMode: "essential",
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const args: AskUserQuestionArgs = params;
				if (!options.ask && !ctx.hasUI)
					return textResult(ASK_UNAVAILABLE_TEXT, { answers: [], cancelled: true });
				const validation = validateQuestionnaire(args);
				if (!validation.ok) return textResult(validation.message, { answers: [], cancelled: true });
				const outcome = await ask({ toolCallId, args, signal, ctx });
				const result = outcomeResult(outcome, args);
				if (result.terminate) options.endRun?.(toolCallId);
				return result;
			},
			renderCall: renderAskCall,
			renderResult: renderAskResult,
		});
	};
}
