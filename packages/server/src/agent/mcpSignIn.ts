import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { LoginFrame, LoginPush } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { liveSessionIdsOf, mcpSessionView } from "./agentSessionManager";
import {
	acquireMcpSignInLock,
	type HostMcpServerConfig,
	loadHostMcpConfig,
	type McpProjectPolicy,
	redactMcpText,
	signInMcpServer,
	signOutMcpServer,
	testMcpConnection,
} from "./mcp";
import { reconnectMcpServer, refreshMcpStatus } from "./mcpSessions";
import { getPiRuntimeGeneration } from "./piRuntime";

const PROBE_DEADLINE_MS = 10 * 60_000;
const SIGN_IN_INSTRUCTIONS = "Finish signing in in your browser.";
const PASTE_BACK = "Paste the address the browser was sent to after signing in";

export type McpProbeAction = "login" | "test" | "logout";

interface Probe {
	loginId: string;
	ownerClientKey: string;
	serverName: string;
	workspaceId: string;
	pendingInput?: (value: string | undefined) => void;
	abort: AbortController;
	settled: boolean;
	cancelled: boolean;
	last?: LoginFrame;
}

const probes = new Map<string, Probe>();
let seq = 0;

let publish: (push: LoginPush, ownerClientKey: string) => void = () => {};
export function setMcpLoginPublisher(fn: (push: LoginPush, ownerClientKey: string) => void): void {
	publish = fn;
}

export function isMcpLoginId(loginId: string): boolean {
	return loginId.startsWith("mcplogin_");
}

function isAllowedSignInUrl(raw: string): boolean {
	if (!URL.canParse(raw)) return false;
	const url = new URL(raw);
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function frame(probe: Probe, raw: LoginFrame): void {
	if (probe.settled) return;
	const next: LoginFrame =
		raw.kind === "error" ? { ...raw, message: redactMcpText(raw.message) } : raw;
	if (next.kind === "success" || next.kind === "error") {
		probe.settled = true;
		probe.last = next;
	}
	publish(
		{
			loginId: probe.loginId,
			providerId: `mcp:${probe.serverName}`,
			frame: next,
			target: { kind: "mcp", workspaceId: probe.workspaceId, serverName: probe.serverName },
		},
		probe.ownerClientKey,
	);
}

function pasteBack(probe: Probe, signal: AbortSignal | undefined): Promise<string> {
	if (probe.settled) return Promise.reject(new Error("Sign-in cancelled."));
	return new Promise<string>((resolve, reject) => {
		const settle = (value: string | undefined) => {
			if (probe.pendingInput === settle) delete probe.pendingInput;
			if (value === undefined) reject(new Error("Sign-in cancelled."));
			else resolve(value);
		};
		probe.pendingInput = settle;
		signal?.addEventListener("abort", () => settle(undefined), { once: true });
		frame(probe, { kind: "prompt", message: PASTE_BACK });
	});
}

function effectiveConfig(
	serverName: string,
	options: { cwd: string; projectTrusted: boolean; policy: McpProjectPolicy },
): HostMcpServerConfig {
	const config = loadHostMcpConfig({ agentDir: getAgentDir(), ...options }).servers.find(
		(server) => server.name === serverName,
	)?.config;
	if (!config) throw new Error(`No admitted MCP server named "${serverName}".`);
	return { ...config, enabled: true };
}

async function runProbe(
	probe: Probe,
	action: McpProbeAction,
	options: { cwd: string; projectTrusted: boolean; policy: McpProjectPolicy },
): Promise<LoginFrame> {
	const { serverName } = probe;
	const config = effectiveConfig(serverName, options);
	const { authStorage } = (await getPiRuntimeGeneration()).runtime;
	if (action === "logout") {
		await signOutMcpServer(config, authStorage);
		return { kind: "success" };
	}
	if (action === "test") {
		const result = await testMcpConnection({
			name: serverName,
			config,
			authStorage,
			cwd: options.cwd,
		});
		if (result.kind === "connected") {
			frame(probe, { kind: "progress", message: `Connected · ${result.toolCount} tools` });
			return { kind: "success" };
		}
		return {
			kind: "error",
			message: result.kind === "needs-sign-in" ? "Reachable — needs sign-in." : result.message,
		};
	}
	await signInMcpServer({
		name: serverName,
		config,
		authStorage,
		cwd: options.cwd,
		signal: probe.abort.signal,
		presentation: {
			onAuthUrl: (url) => {
				if (!isAllowedSignInUrl(url)) {
					throw new Error("The server sent a sign-in address that is not https or loopback.");
				}
				frame(probe, { kind: "authUrl", url, instructions: SIGN_IN_INSTRUCTIONS });
			},
			onPasteBack: (signal) => pasteBack(probe, signal),
		},
	});
	return { kind: "success" };
}

async function reconnectSignedIn(workspaceId: string, serverName: string): Promise<void> {
	for (const sessionId of liveSessionIdsOf(workspaceId)) {
		const snapshot = await refreshMcpStatus(sessionId, 0);
		const state = snapshot?.servers.find((server) => server.name === serverName)?.state;
		if (state === "needs-sign-in" && mcpSessionView(sessionId)) {
			await reconnectMcpServer(sessionId, serverName).catch(() => {});
			await refreshMcpStatus(sessionId, 0);
		}
	}
}

export function startMcpProbe(options: {
	action: McpProbeAction;
	workspaceId: string;
	cwd: string;
	projectTrusted: boolean;
	policy: McpProjectPolicy;
	serverName: string;
	ownerClientKey: string;
	deadlineMs?: number;
}): { loginId: string; done: Promise<LoginFrame> } {
	const { action, serverName } = options;
	const lock = acquireMcpSignInLock(serverName, "settings");
	if ("heldBy" in lock) {
		const where = lock.heldBy === "chat" ? " in a chat" : "";
		throw new Error(`A sign-in for "${serverName}" is already running${where}.`);
	}
	let finish: (last: LoginFrame) => void = () => {};
	const done = new Promise<LoginFrame>((resolve) => {
		finish = resolve;
	});
	const probe: Probe = {
		loginId: `mcplogin_${++seq}`,
		ownerClientKey: options.ownerClientKey,
		serverName,
		workspaceId: options.workspaceId,
		abort: new AbortController(),
		settled: false,
		cancelled: false,
	};
	probes.set(probe.loginId, probe);
	const deadline = setTimeout(
		() => stopProbe(probe, "Sign-in timed out."),
		options.deadlineMs ?? PROBE_DEADLINE_MS,
	);
	void (async () => {
		try {
			frame(probe, {
				kind: "progress",
				message: action === "test" ? "Connecting…" : "Contacting the server…",
			});
			const result = await runProbe(probe, action, options);
			frame(probe, probe.cancelled ? { kind: "error", message: "Sign-in cancelled." } : result);
			if (result.kind === "success" && action === "login" && !probe.cancelled) {
				await reconnectSignedIn(options.workspaceId, serverName);
			}
		} catch (error) {
			frame(probe, {
				kind: "error",
				message: probe.cancelled
					? "Sign-in cancelled."
					: error instanceof Error
						? error.message
						: String(error),
			});
		} finally {
			clearTimeout(deadline);
			probes.delete(probe.loginId);
			lock.release();
			finish(probe.last ?? { kind: "error", message: "Sign-in did not finish." });
		}
	})();
	return { loginId: probe.loginId, done };
}

function ownedProbe(loginId: string, clientKey: string): Probe | undefined {
	const probe = probes.get(loginId);
	if (probe && probe.ownerClientKey !== clientKey) {
		throw new CodedError("LOGIN_NOT_OWNER", "This sign-in was started on another device.");
	}
	return probe;
}

export function replyMcpProbe(loginId: string, clientKey: string, value: string): void {
	ownedProbe(loginId, clientKey)?.pendingInput?.(value);
}

function stopProbe(probe: Probe, message: string): void {
	if (probe.settled) return;
	probe.cancelled = true;
	frame(probe, { kind: "error", message });
	probe.pendingInput?.(undefined);
	probe.abort.abort();
}

export function cancelMcpProbe(loginId: string, clientKey: string): void {
	const probe = ownedProbe(loginId, clientKey);
	if (probe) stopProbe(probe, "Sign-in cancelled.");
}

export function cancelMcpProbesOwnedBy(clientKey: string): void {
	for (const probe of probes.values()) {
		if (probe.ownerClientKey === clientKey) stopProbe(probe, "Sign-in cancelled.");
	}
}

export function cancelAllMcpProbes(): void {
	for (const probe of probes.values()) stopProbe(probe, "Sign-in cancelled.");
}
