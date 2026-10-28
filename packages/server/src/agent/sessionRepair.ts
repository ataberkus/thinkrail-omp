import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { assistantToolCallsAreExecutable } from "@thinkrail/contracts";
import { scanReplayTools } from "pi-delegation";
import type { InteractiveTools } from "../extensions";
import { TOOL_RESPONSE_PENDING_TEXT } from "./toolResponses";

export interface RepairedToolCall {
	toolCallId: string;
	toolName: string;
}

const GENERIC_REPAIR_TEXT =
	"Operation aborted (the host restarted before this tool call completed)";
const TRUNCATED_REPAIR_TEXT =
	"Tool call was not executed because the response hit the output token limit and its arguments may be truncated.";

function latestToolCallIds(sessionManager: SessionManager): Set<string> {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		return new Set(
			entry.message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
		);
	}
	return new Set();
}

export function repairDanglingToolCalls(
	sessionManager: SessionManager,
	interactive: InteractiveTools,
): RepairedToolCall[] {
	const { messages } = sessionManager.buildSessionContext({
		inFlightToolCallIds: latestToolCallIds(sessionManager),
	});
	const { danglingTail: dangling } = scanReplayTools(messages);
	const assistant = messages.findLast((message) => message.role === "assistant");
	const danglingCallsAreExecutable =
		!!assistant && assistantToolCallsAreExecutable(assistant.stopReason);

	for (const toolCall of dangling) {
		const awaitsResponse = danglingCallsAreExecutable && interactive.has(toolCall.toolName);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			content: [
				{
					type: "text",
					text: awaitsResponse
						? TOOL_RESPONSE_PENDING_TEXT
						: danglingCallsAreExecutable
							? GENERIC_REPAIR_TEXT
							: TRUNCATED_REPAIR_TEXT,
				},
			],
			isError: !awaitsResponse,
			...(awaitsResponse ? { details: { kind: "ack" } } : {}),
			timestamp: Date.now(),
		});
	}
	return dangling;
}
