import { PROMPT_ENHANCE_PROTOCOL_VERSION, type PromptEnhanceMessage } from "@thinkrail/contracts";
import { turnAnchorText } from "./recentPrompts";
import type { ChatTurn } from "./types";

const ENHANCE_TAIL = 6;

export function supportsPromptEnhance(protocolVersion: number | null): boolean {
	return protocolVersion !== null && protocolVersion >= PROMPT_ENHANCE_PROTOCOL_VERSION;
}

/** A slash command is run, not rewritten; an empty draft has nothing to enhance. */
export function canEnhanceDraft(draft: string): boolean {
	const text = draft.trim();
	return text !== "" && !text.startsWith("/");
}

/** The turns the enhancer reads: the last few prompts and replies, each assistant run reduced to its last reply. */
export function enhanceConversation(turns: ChatTurn[]): PromptEnhanceMessage[] {
	const out: PromptEnhanceMessage[] = [];
	for (const turn of turns) {
		if (turn.kind !== "user" && turn.kind !== "assistant") continue;
		const text = turnAnchorText(turn).trim();
		if (!text) continue;
		if (turn.kind === "assistant" && out.at(-1)?.role === "assistant") out.pop();
		out.push({ role: turn.kind, text });
	}
	return out.slice(-ENHANCE_TAIL);
}

/**
 * What to do with a settled enhance: `apply` it when the session's draft is still the text that was sent,
 * `offer` it when the user changed the draft meanwhile (never overwrite newer text), `failed` when no
 * rewrite came back, `dropped` when the session is gone.
 */
export function enhanceOutcome(
	original: string,
	current: string | undefined,
	text: string | null,
): "apply" | "offer" | "failed" | "dropped" {
	if (current === undefined) return "dropped";
	if (text === null || !text.trim()) return "failed";
	return current === original ? "apply" : "offer";
}
