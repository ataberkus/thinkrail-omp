import type { PromptEnhanceProgress, WsParams } from "@thinkrail/contracts";
import { suggestPromptEnhancement } from "../assist";

type ProgressPublisher = (clientKey: string, progress: PromptEnhanceProgress) => void;

let publishProgress: ProgressPublisher = () => {};
const running = new Map<string, AbortController>();

export function setPromptEnhanceProgressPublisher(fn: ProgressPublisher): void {
	publishProgress = fn;
}

/** Runs one ✨ Enhance for `clientKey`, pushing each lookup to that client until it settles or is cancelled. */
export async function enhancePrompt(
	params: WsParams<"prompt.enhance">,
	clientKey: string,
): Promise<{ text: string | null }> {
	const key = `${clientKey}\0${params.requestId}`;
	running.get(key)?.abort();
	const controller = new AbortController();
	running.set(key, controller);
	try {
		const text = await suggestPromptEnhancement({
			sessionId: params.sessionId,
			draft: params.draft,
			conversation: params.conversation,
			images: params.images,
			signal: controller.signal,
			onStep: (step) => publishProgress(clientKey, { requestId: params.requestId, step }),
		});
		return { text };
	} finally {
		if (running.get(key) === controller) running.delete(key);
	}
}

export function cancelPromptEnhance(requestId: string, clientKey: string): { ok: true } {
	running.get(`${clientKey}\0${requestId}`)?.abort();
	return { ok: true };
}
