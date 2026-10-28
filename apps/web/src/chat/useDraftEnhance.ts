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

// Outlives the host's 90 s one-shot so its `null` arrives instead of a client timeout.
const ENHANCE_REQUEST_TIMEOUT_MS = 100_000;

interface EnhanceRun {
	sessionId: string;
	original: string;
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
	const shownRef = useRef(sessionId);
	useEffect(() => {
		shownRef.current = sessionId;
	}, [sessionId]);

	const setDraft = (target: string, text: string) => {
		const composer = shownRef.current === target ? composerRef.current : null;
		if (composer) composer.replaceDraftUndoable(text);
		else useAppStore.getState().setChatDraft(target, text);
	};

	const finish = (run: EnhanceRun, text: string | null, error?: unknown) => {
		if (runRef.current !== run) return;
		runRef.current = null;
		setRunningFor(null);
		const current = useAppStore.getState().sessions[run.sessionId]?.draft;
		const outcome = enhanceOutcome(run.original, current, text);
		if (outcome === "dropped") return;
		if (outcome === "failed") {
			const message =
				error === undefined
					? translate("chat.composer.enhance.failed")
					: translate("chat.composer.enhance.failedWith", { error: errorText(error) });
			const composer = shownRef.current === run.sessionId ? composerRef.current : null;
			if (composer) composer.showError(message);
			else toast.error(message);
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

	const toggle = () => {
		const active = runRef.current;
		if (active) {
			if (active.sessionId === sessionId) {
				runRef.current = null;
				setRunningFor(null);
			}
			return;
		}
		const session = useAppStore.getState().sessions[sessionId];
		const original = session?.draft ?? "";
		if (!canEnhanceDraft(original)) return;
		const run = { sessionId, original };
		runRef.current = run;
		setRunningFor(sessionId);
		const conversation = enhanceConversation(session?.turns ?? []);
		getTransport()
			.request(
				"prompt.enhance",
				{ draft: original.trim(), ...(conversation.length > 0 ? { conversation } : {}) },
				{ timeoutMs: ENHANCE_REQUEST_TIMEOUT_MS },
			)
			.then(
				({ text }) => finish(run, text),
				(error: unknown) => finish(run, null, error),
			);
	};

	if (!supported) return null;
	return {
		running: runningFor === sessionId,
		blocked: runningFor !== null && runningFor !== sessionId,
		toggle,
	};
}
