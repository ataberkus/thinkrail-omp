import type { AgentMessage, TranscriptMessage, WireAgentMessage } from "@thinkrail/contracts";

export function wireAgentMessage(message: AgentMessage): WireAgentMessage | null {
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
			return message;
		case "custom":
			return {
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				...(message.details === undefined ? {} : { details: message.details }),
				timestamp: message.timestamp,
			};
		case "hookMessage":
			return {
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				...(message.details === undefined ? {} : { details: message.details }),
				timestamp: message.timestamp,
			};
		case "compactionSummary":
			return {
				role: "compactionSummary",
				summary: message.summary,
				tokensBefore: message.tokensBefore,
				timestamp: message.timestamp,
			};
		case "branchSummary":
			return {
				role: "branchSummary",
				summary: message.summary,
				fromId: message.fromId,
				timestamp: message.timestamp,
			};
		case "bashExecution":
			return {
				role: "bashExecution",
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				timestamp: message.timestamp,
				...(message.excludeFromContext === undefined
					? {}
					: { excludeFromContext: message.excludeFromContext }),
			};
		default:
			return null;
	}
}

export function wireTranscriptMessages(messages: readonly AgentMessage[]): TranscriptMessage[] {
	return messages.flatMap((message) => {
		const wire = wireAgentMessage(message);
		return wire && wire.role !== "branchSummary" && wire.role !== "bashExecution" ? [wire] : [];
	});
}
