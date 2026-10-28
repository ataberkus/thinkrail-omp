import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { type HostSessionEvent, projectSessionEvent } from "./sessionEventProjection";

const compactionResult = {
	summary: "private conversation summary",
	shortSummary: "private short summary",
	firstKeptEntryId: "entry-42",
	tokensBefore: 148_000,
	estimatedTokensAfter: 12_000,
	details: { extensionSecret: "not-for-the-wire" },
};

const allowlisted = JSON.stringify({
	type: "compaction_end",
	reason: "threshold",
	result: { tokensBefore: 148_000, estimatedTokensAfter: 12_000 },
	aborted: false,
	willRetry: false,
});

test("compaction_end serializes only the versioned token-count allowlist", () => {
	const source: HostSessionEvent = {
		type: "compaction_end",
		reason: "threshold",
		result: compactionResult,
		aborted: false,
		willRetry: false,
	};
	expect(JSON.stringify(projectSessionEvent(source, null))).toBe(allowlisted);
});

test("omp's auto_compaction_end serializes the same allowlist under the reason its start reported", () => {
	const source: Extract<AgentSessionEvent, { type: "auto_compaction_end" }> = {
		type: "auto_compaction_end",
		action: "context-full",
		result: compactionResult,
		aborted: false,
		willRetry: false,
	};
	expect(JSON.stringify(projectSessionEvent(source, null, "threshold"))).toBe(allowlisted);
	expect(projectSessionEvent(source, null, "overflow")).toMatchObject({ reason: "overflow" });
});

test("auto_compaction_start maps omp's reasons onto the wire's three", () => {
	const start = (reason: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>["reason"]) =>
		projectSessionEvent({ type: "auto_compaction_start", reason, action: "context-full" }, null);
	expect(start("threshold")).toEqual({ type: "compaction_start", reason: "threshold" });
	expect(start("idle")).toEqual({ type: "compaction_start", reason: "threshold" });
	expect(start("overflow")).toEqual({ type: "compaction_start", reason: "overflow" });
	expect(start("incomplete")).toEqual({ type: "compaction_start", reason: "overflow" });
});

test("tool_execution_end drops the programmatic structuredContent and keeps the rest", () => {
	const source: Extract<AgentSessionEvent, { type: "tool_execution_end" }> = {
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { truncation: undefined },
			structuredContent: { output: "x".repeat(1024), truncated: false, exit_code: 0 },
		},
		isError: false,
	};

	expect(projectSessionEvent(source, null)).toEqual({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "ok" }], details: { truncation: undefined } },
		isError: false,
	});
});

test("tool_execution_update drops structuredContent from the partial result", () => {
	const source: Extract<AgentSessionEvent, { type: "tool_execution_update" }> = {
		type: "tool_execution_update",
		toolCallId: "call-2",
		toolName: "stream_tool",
		args: { q: 1 },
		partialResult: {
			content: [{ type: "text", text: "partial" }],
			details: {},
			structuredContent: { rows: ["large"] },
		},
	};

	expect(projectSessionEvent(source, null)).toEqual({
		type: "tool_execution_update",
		toolCallId: "call-2",
		toolName: "stream_tool",
		args: { q: 1 },
		partialResult: { content: [{ type: "text", text: "partial" }], details: {} },
	});
});

test("tool results without structuredContent pass through by identity", () => {
	const result = { content: [{ type: "text" as const, text: "ok" }], details: {} };
	const projected = projectSessionEvent(
		{ type: "tool_execution_end", toolCallId: "call-3", toolName: "read", result, isError: false },
		null,
	);
	expect(projected?.type === "tool_execution_end" && projected.result).toBe(result);
});

test("entry_appended carries only the appended entry's type", () => {
	const projected = projectSessionEvent(
		{
			type: "entry_appended",
			entry: {
				type: "custom",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-10-24T00:00:00.000Z",
				customType: "extension-state",
				data: { secret: "not-for-the-wire" },
			},
		},
		null,
	);
	expect(projected).toEqual({ type: "entry_appended", entryType: "custom" });
});

test("agent_end reports a retry only while the run has not yielded, and keeps wire messages", () => {
	const projected = projectSessionEvent(
		{
			type: "agent_end",
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "hookMessage",
					customType: "note",
					content: "from a hook",
					display: true,
					timestamp: 2,
				},
				{ role: "developer", content: "engine-only directive", timestamp: 3 },
			],
			isTerminal: true,
			yielded: false,
		},
		null,
	);
	expect(projected).toEqual({
		type: "agent_end",
		messages: [
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "custom", customType: "note", content: "from a hook", display: true, timestamp: 2 },
		],
		willRetry: true,
	});
});

test("agent_settled carries the host's terminal settlement", () => {
	expect(projectSessionEvent({ type: "agent_settled", aborted: false }, null)).toEqual({
		type: "agent_settled",
		terminal: null,
	});
});
