import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type Usage,
} from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ProviderConfigInput } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MODEL_NAME = "Faux Model";
const DEFAULT_BASE_URL = "http://localhost:0";
const DEFAULT_API_KEY = "faux";
const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;
const CHARS_PER_TOKEN = 4;

export interface FauxModelDefinition {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export interface FauxProviderState {
	callCount: number;
}

export type FauxResponseFactory = (
	context: Context,
	options: SimpleStreamOptions | undefined,
	state: FauxProviderState,
	model: Model<Api>,
) => AssistantMessage | Promise<AssistantMessage>;

export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export interface RegisterFauxProviderOptions {
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	tokensPerSecond?: number;
	tokenSize?: { min?: number; max?: number };
}

export type FauxStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface FauxCore {
	readonly api: string;
	readonly provider: string;
	readonly models: [Model<Api>, ...Model<Api>[]];
	readonly stream: FauxStreamFunction;
	readonly streamSimple: FauxStreamFunction;
	readonly state: FauxProviderState;
	getModel(): Model<Api>;
	getModel(modelId: string): Model<Api> | undefined;
	setResponses(responses: FauxResponseStep[]): void;
	appendResponses(responses: FauxResponseStep[]): void;
	getPendingResponseCount(): number;
	providerConfig(overrides?: Partial<ProviderConfigInput>): ProviderConfigInput;
}

export interface FauxNativeProvider {
	readonly id: string;
	readonly name: string;
	readonly config: ProviderConfigInput;
}

export interface FauxProviderHandle extends Omit<FauxCore, "providerConfig" | "provider"> {
	readonly provider: FauxNativeProvider;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter += 1;
	return `${prefix}:${Date.now().toString(36)}:${idCounter.toString(36)}`;
}

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function fauxToolCall(
	name: string,
	args: ToolCall["arguments"],
	options: { id?: string } = {},
): ToolCall {
	return { type: "toolCall", id: options.id ?? uniqueId("tool"), name, arguments: args };
}

export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: StopReason;
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
	} = {},
): AssistantMessage {
	const blocks =
		typeof content === "string"
			? [fauxText(content)]
			: Array.isArray(content)
				? content
				: [content];
	return {
		role: "assistant",
		content: blocks,
		api: DEFAULT_API,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		usage: zeroUsage(),
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		...(options.responseId === undefined ? {} : { responseId: options.responseId }),
		timestamp: options.timestamp ?? Date.now(),
	};
}

function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) =>
			block.type === "text" ? block.text : `[image:${block.mimeType}:${block.data.length}]`,
		)
		.join("\n");
}

function assistantText(content: AssistantMessage["content"]): string {
	return content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return block.thinking;
				case "toolCall":
					return `${block.name}:${JSON.stringify(block.arguments)}`;
				default:
					return "";
			}
		})
		.join("\n");
}

function messageText(message: Message): string {
	switch (message.role) {
		case "user":
		case "developer":
			return contentText(message.content);
		case "assistant":
			return assistantText(message.content);
		case "toolResult":
			return [message.toolName, contentText(message.content)].join("\n");
	}
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function sharedPrefixLength(left: readonly string[], right: readonly string[]): number {
	const a = left.join("\n\n");
	const b = right.join("\n\n");
	const limit = Math.min(a.length, b.length);
	let index = 0;
	while (index < limit && a[index] === b[index]) index++;
	return index;
}

function estimateUsage(
	message: AssistantMessage,
	context: Context,
	options: SimpleStreamOptions | undefined,
	promptCache: Map<string, string[]>,
): Usage {
	const prompt = [
		...(context.systemPrompt ?? []).map((part) => `system:${part}`),
		...context.messages.map((entry) => `${entry.role}:${messageText(entry)}`),
	];
	const promptChars = prompt.join("\n\n").length;
	const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
	const output = estimateTokens(assistantText(message.content));
	let input = promptTokens;
	let cacheRead = 0;
	let cacheWrite = 0;
	const sessionId = options?.sessionId;
	if (sessionId && options?.cacheRetention !== "none") {
		const previous = promptCache.get(sessionId);
		if (previous) {
			const cachedChars = sharedPrefixLength(previous, prompt);
			cacheRead = Math.ceil(cachedChars / CHARS_PER_TOKEN);
			cacheWrite = Math.ceil((promptChars - cachedChars) / CHARS_PER_TOKEN);
			input = Math.max(0, promptTokens - cacheRead);
		} else {
			cacheWrite = promptTokens;
		}
		promptCache.set(sessionId, prompt);
	}
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function chunks(text: string, minTokens: number, maxTokens: number): string[] {
	const parts: string[] = [];
	let index = 0;
	while (index < text.length) {
		const tokens = minTokens + Math.floor(Math.random() * (maxTokens - minTokens + 1));
		const size = Math.max(1, tokens * CHARS_PER_TOKEN);
		parts.push(text.slice(index, index + size));
		index += size;
	}
	return parts.length > 0 ? parts : [""];
}

function pace(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
	if (!tokensPerSecond || tokensPerSecond <= 0)
		return new Promise((resolve) => queueMicrotask(resolve));
	const delay = (estimateTokens(chunk) / tokensPerSecond) * 1000;
	return new Promise((resolve) => setTimeout(resolve, delay));
}

function failure(
	model: Model<Api>,
	stopReason: "error" | "aborted",
	errorMessage: string,
	base?: AssistantMessage,
): AssistantMessage {
	return {
		...(base ?? {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			timestamp: Date.now(),
		}),
		stopReason,
		errorMessage,
	};
}

function buildModel(definition: FauxModelDefinition, api: string, provider: string): Model<Api> {
	const { identity } = createMockModel({ provider, id: definition.id });
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		identity,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text", "image"],
		cost: definition.cost ?? ZERO_COST,
		contextWindow: definition.contextWindow ?? 128_000,
		maxTokens: definition.maxTokens ?? 16_384,
		compat: undefined,
	};
}

export function createFauxCore(options: RegisterFauxProviderOptions = {}): FauxCore {
	const api = options.api ?? uniqueId(DEFAULT_API);
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const maxBound = options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE;
	const minTokens = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, maxBound),
	);
	const maxTokens = Math.max(minTokens, maxBound);
	const tokensPerSecond = options.tokensPerSecond;
	const state: FauxProviderState = { callCount: 0 };
	const promptCache = new Map<string, string[]>();
	let pending: FauxResponseStep[] = [];
	const definitions: FauxModelDefinition[] = options.models?.length
		? options.models
		: [
				{
					id: DEFAULT_MODEL_ID,
					name: DEFAULT_MODEL_NAME,
					reasoning: false,
					input: ["text", "image"],
					contextWindow: 128_000,
					maxTokens: 16_384,
				},
			];
	const [first, ...rest] = definitions.map((definition) => buildModel(definition, api, provider));
	if (!first) throw new Error("faux provider needs a model");
	const models: [Model<Api>, ...Model<Api>[]] = [first, ...rest];

	const emit = async (
		stream: AssistantMessageEventStream,
		message: AssistantMessage,
		model: Model<Api>,
		signal: AbortSignal | undefined,
	): Promise<void> => {
		const partial: AssistantMessage = { ...message, content: [] };
		const abort = (): void => {
			const aborted = failure(model, "aborted", "Request was aborted", {
				...partial,
				content: [...partial.content],
			});
			stream.push({ type: "error", reason: "aborted", error: aborted });
		};
		if (signal?.aborted) return abort();
		stream.push({ type: "start", partial: { ...partial } });
		for (let index = 0; index < message.content.length; index++) {
			if (signal?.aborted) return abort();
			const block = message.content[index];
			if (!block) continue;
			if (block.type === "thinking") {
				const live: ThinkingContent = { type: "thinking", thinking: "" };
				partial.content = [...partial.content, live];
				stream.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
				for (const chunk of chunks(block.thinking, minTokens, maxTokens)) {
					await pace(chunk, tokensPerSecond);
					if (signal?.aborted) return abort();
					live.thinking += chunk;
					stream.push({
						type: "thinking_delta",
						contentIndex: index,
						delta: chunk,
						partial: { ...partial },
					});
				}
				stream.push({
					type: "thinking_end",
					contentIndex: index,
					content: block.thinking,
					partial: { ...partial },
				});
				continue;
			}
			if (block.type === "text") {
				const live: TextContent = { type: "text", text: "" };
				partial.content = [...partial.content, live];
				stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
				for (const chunk of chunks(block.text, minTokens, maxTokens)) {
					await pace(chunk, tokensPerSecond);
					if (signal?.aborted) return abort();
					live.text += chunk;
					stream.push({
						type: "text_delta",
						contentIndex: index,
						delta: chunk,
						partial: { ...partial },
					});
				}
				stream.push({
					type: "text_end",
					contentIndex: index,
					content: block.text,
					partial: { ...partial },
				});
				continue;
			}
			if (block.type === "toolCall") {
				const live: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {} };
				partial.content = [...partial.content, live];
				stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
				for (const chunk of chunks(JSON.stringify(block.arguments), minTokens, maxTokens)) {
					await pace(chunk, tokensPerSecond);
					if (signal?.aborted) return abort();
					stream.push({
						type: "toolcall_delta",
						contentIndex: index,
						delta: chunk,
						partial: { ...partial },
					});
				}
				live.arguments = block.arguments;
				stream.push({
					type: "toolcall_end",
					contentIndex: index,
					toolCall: block,
					partial: { ...partial },
				});
				continue;
			}
			partial.content = [...partial.content, block];
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
			return;
		}
		stream.push({ type: "done", reason: message.stopReason, message });
	};

	const stream: FauxStreamFunction = (requestModel, context, streamOptions) => {
		const outer = createAssistantMessageEventStream();
		const step = pending.shift();
		state.callCount++;
		queueMicrotask(() => {
			void (async () => {
				try {
					await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
					if (!step) {
						const empty = failure(requestModel, "error", "No more faux responses queued");
						empty.usage = estimateUsage(empty, context, streamOptions, promptCache);
						outer.push({ type: "error", reason: "error", error: empty });
						return;
					}
					const resolved =
						typeof step === "function"
							? await step(context, streamOptions, state, requestModel)
							: step;
					const message: AssistantMessage = {
						...structuredClone(resolved),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					};
					message.usage = estimateUsage(message, context, streamOptions, promptCache);
					await emit(outer, message, requestModel, streamOptions?.signal);
				} catch (error) {
					outer.push({
						type: "error",
						reason: "error",
						error: failure(
							requestModel,
							"error",
							error instanceof Error ? error.message : String(error),
						),
					});
				}
			})();
		});
		return outer;
	};

	function getModel(): Model<Api>;
	function getModel(modelId: string): Model<Api> | undefined;
	function getModel(modelId?: string): Model<Api> | undefined {
		return modelId === undefined ? models[0] : models.find((model) => model.id === modelId);
	}

	return {
		api,
		provider,
		models,
		stream,
		streamSimple: stream,
		state,
		getModel,
		setResponses(responses) {
			pending = [...responses];
		},
		appendResponses(responses) {
			pending.push(...responses);
		},
		getPendingResponseCount() {
			return pending.length;
		},
		providerConfig(overrides = {}) {
			return {
				api,
				baseUrl: DEFAULT_BASE_URL,
				apiKey: DEFAULT_API_KEY,
				streamSimple: stream,
				models: definitions.map((definition) => ({
					id: definition.id,
					name: definition.name ?? definition.id,
					reasoning: definition.reasoning ?? false,
					input: definition.input ?? ["text", "image"],
					cost: definition.cost ?? ZERO_COST,
					contextWindow: definition.contextWindow ?? 128_000,
					maxTokens: definition.maxTokens ?? 16_384,
				})),
				...overrides,
			};
		},
	};
}

export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
	const { providerConfig, ...core } = createFauxCore(options);
	return {
		...core,
		provider: { id: core.provider, name: core.provider, config: providerConfig() },
	};
}
