import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { type ExtUiRequest, MCP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import {
	disposeAllSessions,
	mcpSessionView,
	promptSession,
	reloadSessionResources,
	setSessionMcpServerEnabled,
	settleSessionsForShutdown,
} from "./agentSessionManager";
import { type McpHarness, startMcpHarness, stdioFixture } from "./mcp/fixtures/harness";
import {
	hasFailedMcpReload,
	pendingMcpReload,
	reconcileMcpSessions,
	refreshMcpStatus,
	setMcpStatusPublisher,
	watchUserMcpConfig,
} from "./mcpSessions";
import { type ExtUiAudience, setExtUiPublisher } from "./webUiContext";

let h: McpHarness;
let agentDir = "";
let root = "";
let cwd = "";
const fixture = stdioFixture;
let notices: { request: ExtUiRequest; audience?: ExtUiAudience }[] = [];

function writeConfig(enabled = true, server: Record<string, unknown> = {}): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				fixture: {
					command: process.execPath,
					args: [fixture],
					exposure: "direct",
					enabled,
					...server,
				},
			},
		}),
	);
}

beforeAll(async () => {
	h = await startMcpHarness("mcp-status");
	agentDir = h.agentDir;
	root = h.root;
	cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	setExtUiPublisher((request, audience) =>
		notices.push({ request, ...(audience ? { audience } : {}) }),
	);
});

beforeEach(() => {
	notices = [];
	writeConfig();
});

afterEach(async () => {
	await settleSessionsForShutdown();
	disposeAllSessions();
	rmSync(join(agentDir, "extensions"), { recursive: true, force: true });
});

afterAll(async () => {
	setExtUiPublisher(() => {});
	await h.teardown();
});

const chat = () => h.chatIn("mcp-status-workspace", cwd);

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
	const until = Date.now() + 5_000;
	while (!(await check())) {
		if (Date.now() > until) throw new Error("MCP status did not converge");
		await Bun.sleep(20);
	}
}

const errorNotices = () =>
	notices.flatMap(({ request }) =>
		request.kind === "notify" && request.level === "error" ? [request] : [],
	);

function failAfterLoad(
	failOn: (attempt: number) => boolean,
	message = "fixture failed with token=private-value",
): { attempts: () => number; restore(): void } {
	const original = AgentSession.prototype.subscribe;
	let attempts = 0;
	const spy = spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (
		this: AgentSession,
		listener,
	) {
		const unsubscribe = original.call(this, listener);
		if (!new Error().stack?.includes("attachEngineSession")) return unsubscribe;
		attempts++;
		if (failOn(attempts)) throw new Error(message);
		return unsubscribe;
	});
	return { attempts: () => attempts, restore: () => spy.mockRestore() };
}

function failBeforeLoad(failOn: (attempt: number) => boolean): {
	attempts: () => number;
	restore(): void;
} {
	const original = SessionManager.prototype.cloneCurrentSession;
	let attempts = 0;
	const spy = spyOn(SessionManager.prototype, "cloneCurrentSession").mockImplementation(function (
		this: SessionManager,
		options,
	) {
		const stack = new Error().stack ?? "";
		if (stack.includes("replaceEngineSession") && !stack.includes("reopen")) {
			attempts++;
			if (failOn(attempts)) throw new Error("fixture loader failed");
		}
		return original.call(this, options);
	});
	return { attempts: () => attempts, restore: () => spy.mockRestore() };
}

function writeExtension(name: string, lines: string[]): string {
	const path = join(agentDir, "extensions", name);
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(path, lines.join("\n"));
	return path;
}

test("legacy startup notifications mask the same credentials as status snapshots", async () => {
	writeConfig(true, { command: join(root, "missing api_key=private-token") });
	const { sessionId } = await chat();
	await waitFor(
		async () =>
			(await refreshMcpStatus(sessionId, 1_000))?.servers.some(
				(server) => server.state === "failed",
			) === true,
	);
	const legacy = notices.filter(({ audience }) => audience?.belowProtocol === MCP_PROTOCOL_VERSION);
	expect(legacy).toHaveLength(1);
	expect(JSON.stringify(legacy)).toContain("api_key=***");
	expect(JSON.stringify(legacy)).not.toContain("private-token");
	const snapshot = await refreshMcpStatus(sessionId, 0);
	expect(JSON.stringify(snapshot)).toContain("api_key=***");
	expect(JSON.stringify(snapshot)).not.toContain("private-token");
});

test("failed reconciliation is reported and retried even after the loaded configuration changed", async () => {
	const { sessionId } = await chat();
	await refreshMcpStatus(sessionId, 5_000);
	writeConfig(false);
	const reload = failAfterLoad((attempt) => attempt === 1);
	const attemptsOf = reload.attempts;
	try {
		await reconcileMcpSessions([sessionId]);
		expect(errorNotices()).toHaveLength(1);
		expect(errorNotices()[0]?.message).toContain("could not apply");
		expect(errorNotices()[0]?.message).toContain("token=***");
		expect(JSON.stringify(notices)).not.toContain("private-value");
		expect(mcpSessionView(sessionId)?.loaded?.get("fixture")?.enabled).toBe(false);
		expect(pendingMcpReload(sessionId).has("fixture")).toBe(true);
		expect(await reconcileMcpSessions([sessionId])).toEqual({ [sessionId]: "reloaded" });
		expect(attemptsOf()).toBe(2);
		expect(hasFailedMcpReload(sessionId)).toBe(false);
		expect(pendingMcpReload(sessionId).size).toBe(0);
		expect(await reconcileMcpSessions([sessionId])).toEqual({});
		expect(errorNotices()).toHaveLength(1);
	} finally {
		reload.restore();
	}
});

test("a failed chat-local disable keeps its intent and retries the same value after the snapshot changed", async () => {
	const { sessionId } = await chat();
	await refreshMcpStatus(sessionId, 5_000);
	const reload = failAfterLoad((attempt) => attempt === 1);
	try {
		await expect(setSessionMcpServerEnabled(sessionId, "fixture", false)).rejects.toThrow(
			"fixture failed",
		);
		expect(mcpSessionView(sessionId)?.disabledInChat.has("fixture")).toBe(true);
		expect(mcpSessionView(sessionId)?.loaded?.get("fixture")?.enabled).toBe(false);
		expect(hasFailedMcpReload(sessionId)).toBe(true);
		expect((await refreshMcpStatus(sessionId, 100))?.servers[0]?.state).toBe("pending-reload");
		expect(errorNotices()).toHaveLength(1);
		expect(errorNotices()[0]?.message).toContain("token=***");
		expect(JSON.stringify(notices)).not.toContain("private-value");
		expect(await setSessionMcpServerEnabled(sessionId, "fixture", false)).toBe("reloaded");
		expect(reload.attempts()).toBe(2);
		expect(hasFailedMcpReload(sessionId)).toBe(false);
		expect(pendingMcpReload(sessionId).size).toBe(0);
		expect((await refreshMcpStatus(sessionId, 100))?.servers[0]?.state).toBe("disabled-in-chat");
		expect(await setSessionMcpServerEnabled(sessionId, "fixture", false)).toBe("unchanged");
		expect(await reconcileMcpSessions([sessionId])).toEqual({});
		expect(reload.attempts()).toBe(2);
		expect(errorNotices()).toHaveLength(1);
	} finally {
		reload.restore();
	}
});

test("same-value disable retries after a reload failed before loading, without admitting unknown names", async () => {
	const { sessionId } = await chat();
	await refreshMcpStatus(sessionId, 5_000);
	const reload = failBeforeLoad((attempt) => attempt === 1);
	try {
		await expect(setSessionMcpServerEnabled(sessionId, "fixture", false)).rejects.toThrow(
			"fixture loader failed",
		);
		expect(mcpSessionView(sessionId)?.loaded?.get("fixture")?.enabled).not.toBe(false);
		expect(hasFailedMcpReload(sessionId)).toBe(true);
		await expect(setSessionMcpServerEnabled(sessionId, "missing", false)).rejects.toThrow(
			"No MCP server",
		);
		expect(reload.attempts()).toBe(1);
		expect(await setSessionMcpServerEnabled(sessionId, "fixture", false)).toBe("reloaded");
		expect(reload.attempts()).toBe(2);
		expect(hasFailedMcpReload(sessionId)).toBe(false);
		expect((await refreshMcpStatus(sessionId, 100))?.servers[0]?.state).toBe("disabled-in-chat");
		expect(errorNotices()).toHaveLength(1);
	} finally {
		reload.restore();
	}
});

test("a deferred reconciliation failure is reported once and retried without another config change", async () => {
	const hold = join(root, "hold");
	const entered = join(root, "hold-entered");
	writeFileSync(hold, "");
	writeExtension("hold.ts", [
		'import { existsSync, writeFileSync } from "node:fs";',
		"export default function hold(pi) {",
		'  pi.registerCommand("hold", {',
		"    handler: async () => {",
		`      writeFileSync(${JSON.stringify(entered)}, "");`,
		`      while (existsSync(${JSON.stringify(hold)})) await new Promise(resolve => setTimeout(resolve, 10));`,
		"    },",
		"  });",
		"}",
	]);
	let command: Promise<void> | undefined;
	let reload: ReturnType<typeof failAfterLoad> | undefined;
	try {
		const { sessionId } = await chat();
		reload = failAfterLoad((attempt) => attempt === 1);
		const attempts = reload.attempts;
		await refreshMcpStatus(sessionId, 5_000);
		command = promptSession(sessionId, "/hold");
		await waitFor(() => existsSync(entered));
		writeConfig(false);
		expect(await reconcileMcpSessions([sessionId])).toEqual({ [sessionId]: "deferred" });
		expect(attempts()).toBe(0);
		expect((await refreshMcpStatus(sessionId, 100))?.servers[0]?.state).toBe("pending-reload");
		rmSync(hold);
		await command;
		await waitFor(() => hasFailedMcpReload(sessionId));
		await Bun.sleep(100);
		expect(attempts()).toBe(1);
		expect(errorNotices()).toHaveLength(1);
		expect(errorNotices()[0]?.message).toContain("could not apply");
		expect(errorNotices()[0]?.message).toContain("token=***");
		expect(JSON.stringify(notices)).not.toContain("private-value");
		expect(mcpSessionView(sessionId)?.loaded?.get("fixture")?.enabled).toBe(false);
		expect(pendingMcpReload(sessionId).has("fixture")).toBe(true);
		expect((await refreshMcpStatus(sessionId, 100))?.servers[0]?.state).toBe("pending-reload");
		expect(await reconcileMcpSessions([sessionId])).toEqual({ [sessionId]: "reloaded" });
		expect(attempts()).toBe(2);
		expect(hasFailedMcpReload(sessionId)).toBe(false);
		expect(pendingMcpReload(sessionId).size).toBe(0);
		expect((await refreshMcpStatus(sessionId, 100))?.servers[0]?.state).toBe("disabled");
		expect(await reconcileMcpSessions([sessionId])).toEqual({});
		await Bun.sleep(100);
		expect(attempts()).toBe(2);
		expect(errorNotices()).toHaveLength(1);
	} finally {
		rmSync(hold, { force: true });
		await command;
		reload?.restore();
		rmSync(entered, { force: true });
	}
});

test("a manual reload failure is reported once and retried by reconciliation", async () => {
	const { sessionId } = await chat();
	await refreshMcpStatus(sessionId, 5_000);
	const reload = failAfterLoad((attempt) => attempt === 1);
	try {
		await expect(reloadSessionResources(sessionId)).rejects.toThrow("fixture failed");
		expect(hasFailedMcpReload(sessionId)).toBe(true);
		expect(errorNotices()).toHaveLength(1);
		expect(JSON.stringify(notices)).not.toContain("private-value");
		expect(await reconcileMcpSessions([sessionId])).toEqual({ [sessionId]: "reloaded" });
		expect(reload.attempts()).toBe(2);
		expect(hasFailedMcpReload(sessionId)).toBe(false);
		expect(await reconcileMcpSessions([sessionId])).toEqual({});
		expect(errorNotices()).toHaveLength(1);
	} finally {
		reload.restore();
	}
});

for (const close of [settleSessionsForShutdown, disposeAllSessions]) {
	test(`a late reload failure after ${close.name} stays silent and never restarts status`, async () => {
		const { sessionId } = await chat();
		await refreshMcpStatus(sessionId, 5_000);
		const updates: string[] = [];
		setMcpStatusPublisher((snapshot) => updates.push(snapshot.sessionId));
		const entered = join(root, `late-${close.name}-entered`);
		const released = join(root, `late-${close.name}-released`);
		writeExtension("reload-pause.ts", [
			'import { existsSync, writeFileSync } from "node:fs";',
			"export default async function pause() {",
			`  writeFileSync(${JSON.stringify(entered)}, "");`,
			`  while (!existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));`,
			"}",
		]);
		const reload = failAfterLoad(() => true);
		const reloading = reloadSessionResources(sessionId).then(
			() => null,
			(error: unknown) => error,
		);
		try {
			await waitFor(() => existsSync(entered));
			await close();
			const before = updates.length;
			writeFileSync(released, "");
			expect(await reloading).toBeInstanceOf(Error);
			await Bun.sleep(100);
			expect(errorNotices()).toHaveLength(0);
			expect(hasFailedMcpReload(sessionId)).toBe(false);
			expect(updates).toHaveLength(before);
			expect(await reconcileMcpSessions([sessionId])).toEqual({});
		} finally {
			writeFileSync(released, "");
			await reloading;
			reload.restore();
			setMcpStatusPublisher(() => {});
		}
	});
}

test("the user-config watcher follows a recreated agent directory", async () => {
	const { sessionId } = await chat();
	await refreshMcpStatus(sessionId, 5_000);
	const stop = watchUserMcpConfig();
	try {
		rmSync(agentDir, { recursive: true, force: true });
		writeConfig(false);
		await waitFor(
			async () =>
				(await refreshMcpStatus(sessionId, 100))?.servers.some(
					(server) => server.state === "disabled",
				) === true,
		);
		writeConfig(true);
		await waitFor(
			async () =>
				(await refreshMcpStatus(sessionId, 100))?.servers.some(
					(server) => server.state === "connected",
				) === true,
		);
	} finally {
		stop();
	}
});
