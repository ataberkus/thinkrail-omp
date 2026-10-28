import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type BackgroundCommandStatus = "running" | "stopping" | "completed" | "error" | "stopped";

export interface BackgroundCommandStart {
	command: string;
	name?: string;
	timeout?: number;
}

export interface BackgroundCommandContext {
	cwd: string;
	sessionFile?: string | undefined;
	model?: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined;
	thinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	commandPrefix?: string | undefined;
	exposeSessionEnvironment?: boolean;
}

export interface BackgroundCommandsBinding {
	sessionId: string;
	getContext(): BackgroundCommandContext;
	canDeliverCompletion?(): boolean;
}

export interface BackgroundCommandExecOptions {
	onData(data: Buffer): void;
	signal: AbortSignal;
	timeout?: number;
	env: Record<string, string>;
}

export interface BackgroundCommandOperations {
	exec(
		command: string,
		cwd: string,
		options: BackgroundCommandExecOptions,
	): Promise<{ exitCode: number | null }>;
}

export interface BackgroundCommandsOptions {
	createOperations?(): BackgroundCommandOperations;
}

export interface BackgroundCommandSnapshot {
	readonly id: string;
	readonly sessionId: string;
	readonly name: string;
	readonly command: string;
	readonly status: BackgroundCommandStatus;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly exitCode?: number | null;
	readonly errorMessage?: string;
}

export interface BackgroundCommandOutput {
	readonly text: string;
	readonly truncated: boolean;
}

export interface BackgroundCommandHandle {
	readonly id: string;
	readonly snapshot: BackgroundCommandSnapshot;
	readonly output: BackgroundCommandOutput | undefined;
	stop(): BackgroundCommandSnapshot;
	claimCompletion(): void;
}

export interface BackgroundCommandCompletion {
	readonly snapshot: BackgroundCommandSnapshot;
	readonly output: BackgroundCommandOutput;
}

export interface BackgroundCommandFlush {
	readonly atTurnEnd?: boolean;
}

export interface BackgroundCommandCompletionBinding {
	deliver(
		batch: readonly BackgroundCommandCompletion[],
		flush: BackgroundCommandFlush,
	): readonly BackgroundCommandCompletion[];
	canDeliverCompletion?(flush: BackgroundCommandFlush): boolean;
}

export interface BackgroundCommands {
	readonly sessionId: string;
	start(input: BackgroundCommandStart): BackgroundCommandHandle;
	list(): BackgroundCommandSnapshot[];
	find(id: string): BackgroundCommandHandle | undefined;
	onChange(listener: () => void): () => void;
	bindCompletion(binding: BackgroundCommandCompletionBinding): () => void;
	flushCompletions(flush?: BackgroundCommandFlush): void;
	dispose(options?: { timeoutMs?: number }): Promise<void>;
}
