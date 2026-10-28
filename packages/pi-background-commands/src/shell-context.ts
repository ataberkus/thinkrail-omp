import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { BackgroundCommandContext, BackgroundCommandOperations } from "./types";

export function shellEnvironment(
	sessionId: string,
	context: BackgroundCommandContext,
): Record<string, string> {
	const expose = context.exposeSessionEnvironment !== false;
	return {
		PI_SESSION_ID: expose ? sessionId : "",
		PI_SESSION_FILE: (expose && context.sessionFile) || "",
		PI_PROVIDER: (expose && context.model?.provider) || "",
		PI_MODEL: (expose && context.model?.id) || "",
		PI_REASONING_LEVEL: (expose && context.thinkingLevel) || "",
	};
}

export function standaloneContext(
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "getThinkingLevel">,
): BackgroundCommandContext {
	return {
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile(),
		model: ctx.model,
		thinkingLevel: pi.getThinkingLevel(),
	};
}

export function createEngineOperations(): BackgroundCommandOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			const result = await executeBash(command, {
				cwd,
				env,
				signal,
				timeout: timeout === undefined ? 0 : Math.max(1, Math.round(timeout * 1000)),
				chunkThrottleMs: 0,
				onChunk: (chunk) => onData(Buffer.from(chunk, "utf8")),
				sessionKey: `background-command:async:${randomUUID()}`,
			});
			if (result.timedOut) throw new Error(`Command timed out after ${timeout} seconds`);
			if (result.cancelled) throw new Error("Command cancelled");
			return { exitCode: result.exitCode ?? null };
		},
	};
}
