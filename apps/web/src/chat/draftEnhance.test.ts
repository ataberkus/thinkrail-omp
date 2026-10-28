import { expect, test } from "bun:test";
import { PROMPT_ENHANCE_PROTOCOL_VERSION } from "@thinkrail/contracts";
import {
	canEnhanceDraft,
	enhanceConversation,
	enhanceOutcome,
	supportsPromptEnhance,
} from "./draftEnhance";
import type { ChatTurn } from "./types";

const user = (id: string, text: string) => ({
	kind: "user",
	id,
	message: { role: "user", content: text },
});
const assistant = (id: string, text: string) => ({
	kind: "assistant",
	id,
	streaming: false,
	message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
});

test("a settled rewrite replaces only the draft it was asked for", () => {
	expect(enhanceOutcome("fix it", "fix it", "## Request\nFix it.")).toBe("apply");
	expect(enhanceOutcome("fix it", "fix it now", "## Request\nFix it.")).toBe("offer");
	expect(enhanceOutcome("fix it", "fix it", null)).toBe("failed");
	expect(enhanceOutcome("fix it", "fix it now", "  ")).toBe("failed");
	expect(enhanceOutcome("fix it", undefined, "## Request")).toBe("dropped");
});

test("only a non-empty, non-command draft can be enhanced, and only from a v94 host", () => {
	expect(canEnhanceDraft("  why is it slow?  ")).toBe(true);
	expect(canEnhanceDraft(" \n ")).toBe(false);
	expect(canEnhanceDraft("  /model opus")).toBe(false);
	expect(supportsPromptEnhance(PROMPT_ENHANCE_PROTOCOL_VERSION)).toBe(true);
	expect(supportsPromptEnhance(PROMPT_ENHANCE_PROTOCOL_VERSION - 1)).toBe(false);
	expect(supportsPromptEnhance(null)).toBe(false);
});

test("the conversation keeps the last six turns, each assistant run reduced to its last reply", () => {
	const turns = [
		user("u0", "first"),
		assistant("a0", "old"),
		user("u1", "q1"),
		assistant("a1", "checking"),
		assistant("a2", ""),
		assistant("a3", "options: 1, 2"),
		{ kind: "system", id: "s", text: "compacted" },
		user("u2", "q2"),
		assistant("a4", "done"),
		user("u3", "  "),
		user("u4", "q3"),
	] as unknown as ChatTurn[];
	expect(enhanceConversation(turns)).toEqual([
		{ role: "assistant", text: "old" },
		{ role: "user", text: "q1" },
		{ role: "assistant", text: "options: 1, 2" },
		{ role: "user", text: "q2" },
		{ role: "assistant", text: "done" },
		{ role: "user", text: "q3" },
	]);
});
