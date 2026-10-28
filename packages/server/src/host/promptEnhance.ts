import type { PromptEnhanceProgress, WsParams, WsResult } from "@thinkrail/contracts";
import { suggestPromptEnhancement } from "../assist";

type ProgressPublisher = (clientKey: string, progress: PromptEnhanceProgress) => void;

let publishProgress: ProgressPublisher = () => {};
const running = new Map<string, AbortController>();

export function setPromptEnhanceProgressPublisher(fn: ProgressPublisher): void {
	publishProgress = fn;
}

/** Runs one ✨ Enhance for `clientKey`, pushing its model and each lookup to that client until it settles or is cancelled. */
export async function enhancePrompt(
	params: WsParams<"prompt.enhance">,
	clientKey: string,
): Promise<WsResult<"prompt.enhance">> {
	const key = `${clientKey}\0${params.requestId}`;
	running.get(key)?.abort();
	const controller = new AbortController();
	running.set(key, controller);
	let model = "";
	const publish = (step: PromptEnhanceProgress["step"]) =>
		publishProgress(clientKey, { requestId: params.requestId, model, step });
	try {
		return await suggestPromptEnhancement({
			sessionId: params.sessionId,
			draft: params.draft,
			conversation: params.conversation,
			images: params.images,
			signal: controller.signal,
			onModel: (name) => {
				model = name;
				publish(null);
			},
			onStep: publish,
		});
	} finally {
		if (running.get(key) === controller) running.delete(key);
	}
}

export function cancelPromptEnhance(requestId: string, clientKey: string): { ok: true } {
	running.get(`${clientKey}\0${requestId}`)?.abort();
	return { ok: true };
}
