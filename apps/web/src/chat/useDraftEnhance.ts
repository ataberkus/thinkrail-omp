import {
	type ImageContent,
	type PromptEnhanceFailure,
	type PromptEnhanceProgress,
	WS_CHANNELS,
	type WsResult,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { t as translate } from "@thinkrail/locales/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { toast, useAppStore } from "@/store";
import { errorText, getTransport } from "@/transport";
import type { ComposerEnhance, ComposerHandle } from "./Composer";
import {
	canEnhanceDraft,
	enhanceConversation,
	enhanceOutcome,
	supportsPromptEnhance,
} from "./draftEnhance";

// Outlives the host's 240 s run so its `timeout` answer arrives instead of a client timeout.
const ENHANCE_REQUEST_TIMEOUT_MS = 250_000;

const FAILURE_KEYS: Partial<Record<PromptEnhanceFailure, MessageKey>> = {
	tooLong: "chat.composer.enhance.failedTooLong",
	unavailable: "chat.composer.enhance.failedUnavailable",
	timeout: "chat.composer.enhance.failedTimeout",
	emptyOutput: "chat.composer.enhance.failedEmpty",
};

function failureMessage({ reason, error }: WsResult<"prompt.enhance">): string {
	if (reason === "error" && error) return translate("chat.composer.enhance.failedWith", { error });
	return translate((reason && FAILURE_KEYS[reason]) || "chat.composer.enhance.failed");
}

interface EnhanceRun {
	sessionId: string;
	requestId: string;
	original: string;
	unsubscribe: () => void;
}

/**
 * The message box's ✨ Enhance: one `prompt.enhance` per click, the result swapped into the draft it was
 * asked for. `null` against a host older than the method.
 */
export function useDraftEnhance(
	sessionId: string,
	composerRef: RefObject<ComposerHandle | null>,
): ComposerEnhance | null {
	const supported = useAppStore((s) => supportsPromptEnhance(s.protocolVersion));
	const runRef = useRef<EnhanceRun | null>(null);
	const [runningFor, setRunningFor] = useState<string | null>(null);
	const [progress, setProgress] = useState<PromptEnhanceProgress | null>(null);
	const shownRef = useRef(sessionId);
	useEffect(() => {
		shownRef.current = sessionId;
	}, [sessionId]);

	const setDraft = (target: string, text: string) => {
		const composer = shownRef.current === target ? composerRef.current : null;
		if (composer) composer.replaceDraftUndoable(text);
		else useAppStore.getState().setChatDraft(target, text);
	};

	const finish = (run: EnhanceRun, text: string | null, failure: string) => {
		if (runRef.current !== run) return;
		runRef.current = null;
		run.unsubscribe();
		setRunningFor(null);
		setProgress(null);
		const current = useAppStore.getState().sessions[run.sessionId]?.draft;
		const outcome = enhanceOutcome(run.original, current, text);
		if (outcome === "dropped") return;
		if (outcome === "failed") {
			const composer = shownRef.current === run.sessionId ? composerRef.current : null;
			if (composer) composer.showError(failure);
			else toast.error(failure);
			return;
		}
		const enhanced = text ?? "";
		if (outcome === "apply") {
			setDraft(run.sessionId, enhanced);
			useAppStore.getState().pushToast({
				variant: "success",
				title: translate("chat.composer.enhance.done"),
				message: translate("chat.composer.enhance.doneMessage"),
				durationMs: 8000,
				action: {
					label: translate("chat.composer.enhance.undo"),
					onClick: () => setDraft(run.sessionId, run.original),
				},
			});
			return;
		}
		useAppStore.getState().pushToast({
			variant: "info",
			title: translate("chat.composer.enhance.ready"),
			message: translate("chat.composer.enhance.readyMessage"),
			durationMs: 15000,
			action: {
				label: translate("chat.composer.enhance.use"),
				onClick: () => setDraft(run.sessionId, enhanced),
			},
		});
	};

	const toggle = (images: ImageContent[]) => {
		const active = runRef.current;
		if (active) {
			if (active.sessionId === sessionId) {
				runRef.current = null;
				active.unsubscribe();
				setRunningFor(null);
				setProgress(null);
				void getTransport()
					.request("prompt.enhanceCancel", { requestId: active.requestId })
					.catch(() => {});
			}
			return;
		}
		const session = useAppStore.getState().sessions[sessionId];
		const original = session?.draft ?? "";
		if (!canEnhanceDraft(original)) return;
		const requestId = crypto.randomUUID();
		const unsubscribe = getTransport().subscribe(WS_CHANNELS.promptEnhanceProgress, (data) => {
			const update = data as PromptEnhanceProgress;
			if (update.requestId === requestId && runRef.current?.requestId === requestId)
				setProgress(update);
		});
		const run = { sessionId, requestId, original, unsubscribe };
		runRef.current = run;
		setRunningFor(sessionId);
		const conversation = enhanceConversation(session?.turns ?? []);
		getTransport()
			.request(
				"prompt.enhance",
				{
					sessionId,
					requestId,
					draft: original.trim(),
					...(conversation.length > 0 ? { conversation } : {}),
					...(images.length > 0 ? { images } : {}),
				},
				{ timeoutMs: ENHANCE_REQUEST_TIMEOUT_MS },
			)
			.then(
				(result) => finish(run, result.text, failureMessage(result)),
				(error: unknown) =>
					finish(
						run,
						null,
						translate("chat.composer.enhance.failedWith", { error: errorText(error) }),
					),
			);
	};

	if (!supported) return null;
	return {
		running: runningFor === sessionId,
		blocked: runningFor !== null && runningFor !== sessionId,
		progress: runningFor === sessionId ? progress : null,
		toggle,
	};
}
