import type { AgentSessionEvent, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { AgentSettlement, PiEvent } from "@thinkrail/contracts";
import { wireThinkingLevel } from "./piThinking";
import { wireAgentMessage } from "./wireMessages";

export type CompactionReason = "manual" | "threshold" | "overflow";

export type HostSessionEvent =
	| AgentSessionEvent
	| { type: "agent_settled"; aborted: boolean }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "compaction_start"; reason: CompactionReason }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: { tokensBefore: number; estimatedTokensAfter?: number } | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  };

export function compactionReasonOf(
	reason: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>["reason"],
): CompactionReason {
	return reason === "overflow" || reason === "incomplete" ? "overflow" : "threshold";
}

function compactionResult(
	result: { tokensBefore: number; estimatedTokensAfter?: number } | undefined,
): { tokensBefore: number; estimatedTokensAfter?: number } | undefined {
	if (!result) return undefined;
	return {
		tokensBefore: result.tokensBefore,
		...(result.estimatedTokensAfter !== undefined
			? { estimatedTokensAfter: result.estimatedTokensAfter }
			: {}),
	};
}

export function projectSessionEvent(
	event: HostSessionEvent,
	terminal: AgentSettlement | null,
	compactionReason: CompactionReason = "threshold",
): PiEvent | null {
	switch (event.type) {
		case "agent_settled":
			return { type: "agent_settled", terminal };
		case "entry_appended":
			return { type: "entry_appended", entryType: event.entry.type };
		case "session_info_changed":
			return { type: "session_info_changed", name: event.name };
		case "compaction_start":
			return { type: "compaction_start", reason: event.reason };
		case "auto_compaction_start":
			return { type: "compaction_start", reason: compactionReasonOf(event.reason) };
		case "compaction_end":
			return {
				type: "compaction_end",
				reason: event.reason,
				result: compactionResult(event.result),
				aborted: event.aborted,
				willRetry: event.willRetry,
				...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
			};
		case "auto_compaction_end":
			return {
				type: "compaction_end",
				reason: compactionReason,
				result: compactionResult(event.result),
				aborted: event.aborted,
				willRetry: event.willRetry,
				...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
			};
		case "agent_end":
			return {
				type: "agent_end",
				messages: event.messages.flatMap((message) => wireAgentMessage(message) ?? []),
				willRetry: event.yielded === false,
			};
		case "thinking_level_changed":
			return { type: "thinking_level_changed", level: wireThinkingLevel(event.thinkingLevel) };
		case "queue_update":
			return { type: "queue_update", steering: event.steering, followUp: event.followUp };
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				...(event.finalError !== undefined ? { finalError: event.finalError } : {}),
			};
		case "tool_execution_end":
			return { ...event, result: withoutStructured(event.result) };
		case "tool_execution_update":
			return { ...event, partialResult: withoutStructured(event.partialResult) };
		case "turn_end": {
			const message = wireAgentMessage(event.message);
			return message ? { ...event, message } : null;
		}
		case "message_start":
		case "message_end": {
			const message = wireAgentMessage(event.message);
			return message ? { ...event, message } : null;
		}
		case "message_update": {
			const message = wireAgentMessage(event.message);
			return message ? { ...event, message } : null;
		}
		case "agent_start":
		case "turn_start":
		case "tool_execution_start":
		case "tool_stream_update":
			return event;
		default:
			return null;
	}
}

function withoutStructured(result: unknown): unknown {
	if (typeof result !== "object" || result === null || !("structuredContent" in result))
		return result;
	const { structuredContent: _structuredContent, ...rest } = result;
	return rest;
}
