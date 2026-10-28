import { mock } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import * as runtimeInit from "@oh-my-pi/pi-coding-agent/modes/runtime-init";

type InitializeExtensions = typeof runtimeInit.initializeExtensions;

/** Runs in place of one extension binding; `bind` performs omp's own binding. */
export type ExtensionBindingHook = (
	session: AgentSession,
	bind: () => Promise<void>,
) => Promise<void>;

const initializeExtensions: InitializeExtensions = runtimeInit.initializeExtensions;
let hook: ExtensionBindingHook | undefined;

const intercepted: InitializeExtensions = (session, options) => {
	const bind = () => initializeExtensions(session, options);
	return hook ? hook(session, bind) : bind();
};

mock.module("@oh-my-pi/pi-coding-agent/modes/runtime-init", () => ({
	...runtimeInit,
	initializeExtensions: intercepted,
}));

/**
 * Hold or fail the host's attach window, which binds extensions through omp's
 * `initializeExtensions`. Returns the restore; later bindings run unwrapped again.
 */
export function interceptExtensionBinding(next: ExtensionBindingHook): () => void {
	hook = next;
	return () => {
		if (hook === next) hook = undefined;
	};
}
