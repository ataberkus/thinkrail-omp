import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, StopReason, ToolResultMessage } from "@thinkrail/contracts";

type FixtureAssistantMessage = {
	role: "assistant";
	timestamp: number;
	stopReason?: StopReason;
	errorMessage?: string;
} & ({ text: string; content?: never } | { text?: never; content: AssistantMessage["content"] });

export type FixtureMessage =
	| { role: "user"; text: string; timestamp: number }
	| FixtureAssistantMessage
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ToolResultMessage["content"];
			details?: unknown;
			isError: boolean;
			timestamp: number;
	  };

export function writeFixtureSession(
	dir: string,
	opts: {
		id?: string;
		cwd: string;
		name?: string;
		messages: FixtureMessage[];
	},
): { id: string; path: string } {
	mkdirSync(dir, { recursive: true });

	const sessionId = opts.id ?? `sess-${randomUUID()}`;
	const entryId = (suffix: string) => `${sessionId}-${suffix}`;
	let parentId: string | null = null;
	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			...(opts.name !== undefined ? { title: opts.name, titleSource: "user" } : {}),
			timestamp: new Date(opts.messages[0]?.timestamp ?? Date.now()).toISOString(),
			cwd: opts.cwd,
		}),
	];

	opts.messages.forEach((m, i) => {
		const id = entryId(`m${i}`);
		const content =
			m.role === "user"
				? m.text
				: m.role === "assistant"
					? (m.content ?? [{ type: "text", text: m.text }])
					: m.content;
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: new Date(m.timestamp).toISOString(),
				message: {
					role: m.role,
					content,
					timestamp: m.timestamp,
					...(m.role === "assistant" && m.stopReason ? { stopReason: m.stopReason } : {}),
					...(m.role === "assistant" && m.errorMessage !== undefined
						? { errorMessage: m.errorMessage }
						: {}),
					...(m.role === "toolResult"
						? {
								toolCallId: m.toolCallId,
								toolName: m.toolName,
								...(m.details !== undefined ? { details: m.details } : {}),
								isError: m.isError,
							}
						: {}),
				},
			}),
		);
		parentId = id;
	});

	const path = join(dir, `${opts.messages[0]?.timestamp ?? Date.now()}_${sessionId}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return { id: sessionId, path };
}

export function defaultSessionDirFor(agentDir: string, cwd: string): string {
	return SessionManager.getDefaultSessionDir(cwd, agentDir);
}
