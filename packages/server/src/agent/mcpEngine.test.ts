import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { ExtUiRequest } from "@thinkrail/contracts";
import { fauxAssistantMessage, fauxToolCall, isolateAgentDir } from "pi-faux";
import {
	applyPiResourceTrust,
	deleteSession,
	dispatchSessionMcpCommand,
	disposeAllSessions,
	getSessionCommands,
	getSessionMessages,
	getSessionState,
	promptSession,
	removeSession,
	removeWorkspaceSessions,
	requestSessionReload,
	setSessionManagerFactory,
	setSessionMcpServerEnabled,
	setSkillAdmissionResolver,
	setSubagentsEnabledResolver,
	settleSessionsForShutdown,
} from "./agentSessionManager";
import { getSessionResources } from "./chatResources";
import { MCP_CONFIRM_ONCE } from "./mcp";
import { type McpHarness, startMcpHarness, stdioFixture } from "./mcp/fixtures/harness";
import {
	listMcpServers,
	readMcpToolOutput,
	reconcileMcpSessions,
	reconnectMcpServer,
	refreshMcpStatus,
	watchUserMcpConfig,
} from "./mcpSessions";
import { admissionContextFor } from "./skillAdmission";
import { resolveExtUi, setExtUiPublisher } from "./webUiContext";

let h: McpHarness;
let root = "";
let agentDir = "";
let pidFile = "";
let probeMarker = "";
const fixture = stdioFixture;
const testExtensions = [
	"other-mcp.ts",
	"hang-shutdown.ts",
	"hang-reload.ts",
	"reload-pause.ts",
	"closing-probe.ts",
];
let requests: ExtUiRequest[] = [];
let legacyRequests: ExtUiRequest[] = [];

function writeMcpConfig(
	env: Record<string, string> = {},
	extra: Record<string, unknown> = {},
	dir = agentDir,
): void {
	writeFileSync(
		join(dir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				fixture: {
					command: process.execPath,
					args: [fixture],
					env: { MCP_FIXTURE_PID_FILE: pidFile, ...env },
					exposure: "direct",
				},
				...extra,
			},
		}),
	);
}

beforeAll(async () => {
	setSubagentsEnabledResolver(() => true);
	h = await startMcpHarness("engine");
	root = h.root;
	agentDir = h.agentDir;
	pidFile = join(root, "fixture.pids");
	probeMarker = join(root, "probe-starts.log");
	setExtUiPublisher((request, audience) => (audience ? legacyRequests : requests).push(request));
});

function killFixtures(): void {
	for (const pid of pids()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

beforeEach(async () => {
	disposeAllSessions();
	await Bun.sleep(50);
	requests = [];
	legacyRequests = [];
	killFixtures();
	rmSync(pidFile, { force: true });
	rmSync(join(agentDir, "settings.json"), { force: true });
	rmSync(probeMarker, { force: true });
	for (const name of testExtensions) rmSync(join(agentDir, "extensions", name), { force: true });
	writeMcpConfig();
});

function writeExtension(name: string, lines: string[]): void {
	writeFileSync(join(agentDir, "extensions", name), [...lines, ""].join("\n"));
}

function writeHangingShutdownExtension(): void {
	writeExtension("hang-shutdown.ts", [
		"export default function hangShutdown(pi) {",
		'  pi.on("session_shutdown", () => new Promise(() => {}));',
		"}",
	]);
}

afterAll(async () => {
	setExtUiPublisher(() => {});
	await h.teardown();
	killFixtures();
});

function pids(): number[] {
	if (!existsSync(pidFile)) return [];
	return readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor<T>(
	read: () => T | undefined | false | Promise<T | undefined | false>,
	ms = 8000,
): Promise<T> {
	const until = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > until) throw new Error("condition timed out");
		await Bun.sleep(10);
	}
}

function chat() {
	return h.chat();
}

const faux = {
	setResponses: (...args: Parameters<McpHarness["faux"]["setResponses"]>) =>
		h.faux.setResponses(...args),
};

function captureSessions(): { sessions: AgentSession[]; restore(): void } {
	const original = AgentSession.prototype.refreshMCPTools;
	const sessions: AgentSession[] = [];
	AgentSession.prototype.refreshMCPTools = function (tools) {
		if (!sessions.includes(this)) sessions.push(this);
		return original.call(this, tools);
	};
	return {
		sessions,
		restore: () => {
			AgentSession.prototype.refreshMCPTools = original;
		},
	};
}

async function toolTexts(p: Awaited<ReturnType<typeof chat>>): Promise<string[]> {
	const { messages } = await getSessionMessages(p.sessionId, p.workspaceId, p.cwd);
	return messages.flatMap((message) =>
		message.role === "toolResult"
			? [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")]
			: [],
	);
}

const mcpCommands = (sessionId: string) =>
	getSessionCommands(sessionId).filter((command) => command.name === "mcp");

test("a user-level server connects in a chat, its tools are callable, and a write tool asks first", async () => {
	const p = await chat();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("mcp__fixture_echo", { text: "hi" }, { id: "echo" })),
		fauxAssistantMessage(fauxToolCall("mcp__fixture_write_note", { text: "x" }, { id: "write" })),
		fauxAssistantMessage("DONE"),
	]);
	const turn = promptSession(p.sessionId, "Use the fixture.");
	const asked = await waitFor(() => requests.find((request) => request.kind === "select"));
	resolveExtUi({ id: asked.id, value: MCP_CONFIRM_ONCE });
	await turn;
	expect(await toolTexts(p)).toEqual(["echo: hi", "write_note: x"]);
	expect(mcpCommands(p.sessionId)).toHaveLength(1);
	await removeSession(p.sessionId);
});

test("deleting a chat terminates its stdio server, even one that ignores EOF and SIGTERM", async () => {
	writeMcpConfig({ MCP_FIXTURE_STUBBORN: "1" });
	const p = await chat();
	const [pid] = await waitFor(() => (pids().length > 0 ? pids() : undefined));
	expect(alive(pid as number)).toBe(true);
	await removeSession(p.sessionId);
	await waitFor(() => !alive(pid as number), 6000);
}, 15_000);

test("quitting terminates the servers of every live chat", async () => {
	await chat();
	const [pid] = await waitFor(() => (pids().length > 0 ? pids() : undefined));
	await settleSessionsForShutdown();
	disposeAllSessions();
	await waitFor(() => !alive(pid as number), 6000);
});

const SHUTDOWN_DEADLINE_MS = 3500;
const untilDeadline = (started: number) => Math.max(0, started + SHUTDOWN_DEADLINE_MS - Date.now());

test("deleting a chat stops the host's MCP servers within the budget even when another extension's shutdown never settles", async () => {
	writeHangingShutdownExtension();
	writeMcpConfig({ MCP_FIXTURE_STUBBORN: "1" });
	const p = await chat();
	const [pid] = await waitFor(() => (pids().length > 0 ? pids() : undefined));
	const started = Date.now();
	await removeSession(p.sessionId);
	await waitFor(() => !alive(pid as number), untilDeadline(started));
}, 15_000);

test("quitting stops the host's MCP servers within the budget even when another extension's shutdown never settles", async () => {
	writeHangingShutdownExtension();
	writeMcpConfig({ MCP_FIXTURE_STUBBORN: "1" });
	await chat();
	const [pid] = await waitFor(() => (pids().length > 0 ? pids() : undefined));
	const started = Date.now();
	await settleSessionsForShutdown();
	disposeAllSessions();
	await waitFor(() => !alive(pid as number), untilDeadline(started));
}, 15_000);

test("a reload finishes stubborn MCP cleanup before the replacement process starts", async () => {
	writeMcpConfig({ MCP_FIXTURE_STUBBORN: "1" });
	const p = await chat();
	try {
		await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
		const [oldPid] = pids();
		const replacement = join(p.cwd, "replacement.ts");
		writeFileSync(
			replacement,
			[
				'import { appendFileSync } from "node:fs";',
				"let alive = false;",
				`try { process.kill(${oldPid}, 0); alive = true; } catch {}`,
				`appendFileSync(${JSON.stringify(probeMarker)}, alive ? "old-alive\\n" : "old-dead\\n");`,
				`await import(${JSON.stringify(fixture)});`,
			].join("\n"),
		);
		writeMcpConfig(
			{},
			{
				fixture: {
					command: process.execPath,
					args: [replacement],
					env: { MCP_FIXTURE_PID_FILE: pidFile },
					exposure: "direct",
				},
			},
		);
		expect(await requestSessionReload(p.sessionId)).toBe("reloaded");
		await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
		expect(probeStarts()).toEqual(["old-dead"]);
		expect(pids()).toHaveLength(2);
		expect(alive(oldPid as number)).toBe(false);
		expect(alive(pids()[1] as number)).toBe(true);
	} finally {
		await removeSession(p.sessionId);
	}
}, 15_000);

test("omp's own dispose, which emits session_shutdown, and the host's engine shutdown share one cleanup", async () => {
	writeMcpConfig({ MCP_FIXTURE_STUBBORN: "1" });
	const captured = captureSessions();
	try {
		const p = await chat();
		await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
		const [session] = captured.sessions;
		if (!session) throw new Error("Missing engine session");
		const [pid] = pids();
		const closing = removeSession(p.sessionId);
		await session.dispose();
		await closing;
		expect(alive(pid as number)).toBe(false);
	} finally {
		captured.restore();
		disposeAllSessions();
	}
}, 15_000);

for (const reason of ["resource", "trust"] as const) {
	test(`a ${reason} reload stops MCP within budget even when an earlier extension's shutdown hangs`, async () => {
		writeExtension("hang-reload.ts", [
			'import { appendFileSync } from "node:fs";',
			"export default function hangReload(pi) {",
			'  pi.on("session_shutdown", () => {',
			`    appendFileSync(${JSON.stringify(probeMarker)}, "reload\\n");`,
			"    return new Promise(() => {});",
			"  });",
			"}",
		]);
		writeMcpConfig({ MCP_FIXTURE_STUBBORN: "1" });
		setSkillAdmissionResolver(() => admissionContextFor({ piResourceTrust: "granted" }));
		const p = await chat();
		try {
			await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
			const [pid] = pids();
			setSkillAdmissionResolver(() => admissionContextFor(undefined));
			let settled = false;
			const started = Date.now();
			const reloading =
				reason === "resource"
					? requestSessionReload(p.sessionId)
					: applyPiResourceTrust([p.workspaceId]);
			void reloading.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await waitFor(() => probeStarts().includes("reload"));
			await expect(promptSession(p.sessionId, "Stay quiescent.")).rejects.toThrow(/reloading/);
			await waitFor(() => !alive(pid as number), untilDeadline(started));
			expect(settled).toBe(false);
			expect(pids()).toHaveLength(1);
		} finally {
			setSkillAdmissionResolver(() => admissionContextFor(undefined));
			await removeSession(p.sessionId);
		}
	}, 15_000);
}

const closures = [
	["removing the chat", (p: Awaited<ReturnType<typeof chat>>) => removeSession(p.sessionId)],
	[
		"deleting the chat",
		(p: Awaited<ReturnType<typeof chat>>) => deleteSession(p.sessionId, p.workspaceId, p.cwd),
	],
	[
		"removing the workspace",
		(p: Awaited<ReturnType<typeof chat>>) => removeWorkspaceSessions(p.workspaceId, p.cwd),
	],
	["polite host shutdown", () => settleSessionsForShutdown()],
	["emergency host disposal", () => disposeAllSessions()],
] as const;

for (const [label, close] of closures) {
	test(`${label} during a pending resource load prevents MCP restart and cleans up the new runner`, async () => {
		const p = await chat();
		await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
		const before = pids();
		const entered = join(p.cwd, "reload-entered");
		const released = join(p.cwd, "reload-released");
		writeExtension("reload-pause.ts", [
			'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
			"export default async function pause(pi) {",
			`  writeFileSync(${JSON.stringify(entered)}, "");`,
			`  while (!existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));`,
			`  pi.on("session_start", () => appendFileSync(${JSON.stringify(probeMarker)}, "started\\n"));`,
			'  pi.on("session_shutdown", async () => {',
			"    await new Promise(resolve => setTimeout(resolve, 50));",
			'    pi.getFlag("probe");',
			`    appendFileSync(${JSON.stringify(probeMarker)}, "shutdown\\n");`,
			"  });",
			"}",
		]);
		const reloading = requestSessionReload(p.sessionId).then(
			() => "reloaded",
			(error: Error) => error.message,
		);
		try {
			await waitFor(() => existsSync(entered));
			const started = Date.now();
			await close(p);
			expect(Date.now() - started).toBeLessThan(SHUTDOWN_DEADLINE_MS);
			await waitFor(() => before.every((pid) => !alive(pid)));
			writeFileSync(released, "");
			expect(await reloading).toBe("The chat is closing.");
			expect(probeStarts()).toEqual(["shutdown"]);
			await Bun.sleep(100);
			expect(pids()).toEqual(before);
		} finally {
			writeFileSync(released, "");
			await reloading;
			disposeAllSessions();
		}
	}, 15_000);
}

for (const [label, close] of closures) {
	test(`${label} during a paused session_start prevents late MCP startup after shutdown`, async () => {
		const p = await chat();
		await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
		const before = pids();
		const entered = join(p.cwd, "start-entered");
		const released = join(p.cwd, "start-released");
		writeExtension("reload-pause.ts", [
			'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
			"export default function pause(pi) {",
			'  pi.on("session_start", async () => {',
			`    writeFileSync(${JSON.stringify(entered)}, "");`,
			`    while (!existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));`,
			`    appendFileSync(${JSON.stringify(probeMarker)}, "resumed\\n");`,
			"  });",
			'  pi.on("session_shutdown", () => {',
			`    appendFileSync(${JSON.stringify(probeMarker)}, "shutdown\\n");`,
			"  });",
			'  pi.on("resources_discover", async () => {',
			"    await new Promise(resolve => setTimeout(resolve, 100));",
			`    appendFileSync(${JSON.stringify(probeMarker)}, "discovered\\n");`,
			"  });",
			"}",
		]);
		const reloading = requestSessionReload(p.sessionId).then(
			() => "reloaded",
			(error: Error) => error.message,
		);
		try {
			await waitFor(() => existsSync(entered));
			const started = Date.now();
			await close(p);
			expect(Date.now() - started).toBeLessThan(SHUTDOWN_DEADLINE_MS);
			await waitFor(() => probeStarts().includes("shutdown"));
			expect(before.every((pid) => !alive(pid))).toBe(true);
			writeFileSync(released, "");
			const outcome = await reloading;
			expect(probeStarts()).toEqual(["shutdown", "resumed"]);
			await Bun.sleep(100);
			expect(pids()).toEqual(before);
			expect(outcome).toBe("The chat is closing.");
			disposeAllSessions();
			await Bun.sleep(100);
			expect(pids()).toEqual(before);
		} finally {
			writeFileSync(released, "");
			await reloading;
			disposeAllSessions();
		}
	}, 15_000);
}

test("emergency disposal during graceful closure waits for the replacement runner's own shutdown", async () => {
	const oldEntered = join(root, "old-shutdown-entered");
	const oldReleased = join(root, "old-shutdown-released");
	const loadEntered = join(root, "overlap-load-entered");
	const loadReleased = join(root, "overlap-load-released");
	const newEntered = join(root, "new-shutdown-entered");
	const newReleased = join(root, "new-shutdown-released");
	writeExtension("closing-probe.ts", [
		'import { existsSync, writeFileSync } from "node:fs";',
		"export default function closing(pi) {",
		'  pi.on("session_shutdown", async () => {',
		`    writeFileSync(${JSON.stringify(oldEntered)}, "");`,
		`    while (!existsSync(${JSON.stringify(oldReleased)})) await new Promise(resolve => setTimeout(resolve, 10));`,
		"  });",
		"}",
	]);
	const p = await chat();
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	const before = pids();
	rmSync(join(agentDir, "extensions", "closing-probe.ts"));
	writeExtension("reload-pause.ts", [
		'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
		"export default async function pause(pi) {",
		`  writeFileSync(${JSON.stringify(loadEntered)}, "");`,
		`  while (!existsSync(${JSON.stringify(loadReleased)})) await new Promise(resolve => setTimeout(resolve, 10));`,
		`  pi.on("session_start", () => appendFileSync(${JSON.stringify(probeMarker)}, "started\\n"));`,
		'  pi.on("session_shutdown", async () => {',
		`    writeFileSync(${JSON.stringify(newEntered)}, "");`,
		`    while (!existsSync(${JSON.stringify(newReleased)})) await new Promise(resolve => setTimeout(resolve, 10));`,
		'    pi.getFlag("probe");',
		`    appendFileSync(${JSON.stringify(probeMarker)}, "shutdown\\n");`,
		"  });",
		"}",
	]);
	const reloading = requestSessionReload(p.sessionId).then(
		() => "reloaded",
		(error: Error) => error.message,
	);
	let closing: Promise<void> | undefined;
	try {
		await waitFor(() => existsSync(loadEntered));
		closing = settleSessionsForShutdown();
		await waitFor(() => existsSync(oldEntered));
		writeFileSync(loadReleased, "");
		await waitFor(() => existsSync(newEntered));
		disposeAllSessions();
		writeFileSync(oldReleased, "");
		await closing;
		writeFileSync(newReleased, "");
		expect(await reloading).toBe("The chat is closing.");
		expect(probeStarts()).toEqual(["shutdown"]);
		expect(pids()).toEqual(before);
		expect(before.every((pid) => !alive(pid))).toBe(true);
	} finally {
		for (const file of [oldReleased, loadReleased, newReleased]) writeFileSync(file, "");
		await reloading;
		await closing;
		disposeAllSessions();
	}
}, 15_000);

test("a chat whose preparation fails after the host started its servers still stops them", async () => {
	writeMcpConfig({ MCP_FIXTURE_STUBBORN: "1" });
	const original = AgentSession.prototype.setPendingMCPDiscovery;
	AgentSession.prototype.setPendingMCPDiscovery = function (discovery) {
		original.call(this, discovery);
		queueMicrotask(() => disposeAllSessions());
	};
	try {
		const failed = chat().then(
			() => "registered",
			(error: Error) => error.message,
		);
		const started = Date.now();
		expect(await failed).toContain("Workspace is unavailable");
		await Bun.sleep(500);
		await waitFor(() => pids().every((pid) => !alive(pid)), untilDeadline(started));
		expect(pids().every((pid) => !alive(pid))).toBe(true);
	} finally {
		AgentSession.prototype.setPendingMCPDiscovery = original;
	}
}, 15_000);

test("an installed extension that registers /mcp neither replaces the host's command nor starts a server twice", async () => {
	writeFileSync(
		join(agentDir, "extensions", "other-mcp.ts"),
		[
			"export default function otherMcp(pi) {",
			'  pi.registerCommand("mcp", { description: "another MCP manager", handler: async () => {} });',
			"}",
			"",
		].join("\n"),
	);
	const p = await chat();
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	expect(mcpCommands(p.sessionId).map((command) => command.description)).toEqual([
		"MCP servers: status, login <server>, logout <server>, reconnect <server>",
	]);
	expect(pids()).toHaveLength(1);
	const listed = await listMcpServers({
		workspaceId: p.workspaceId,
		cwd: p.cwd,
		project: undefined,
		waitMs: 500,
	});
	expect(listed.statuses.map((snapshot) => snapshot.sessionId)).toEqual([p.sessionId]);
	await removeSession(p.sessionId);
});

test("a subagent run starts no MCP server of its own", async () => {
	const p = await chat();
	await waitFor(() => (pids().length > 0 ? pids() : undefined));
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"Agent",
				{ subagent_type: "scout", task: "Look around.", model: "engine/engine" },
				{ id: "agent" },
			),
		),
		fauxAssistantMessage("CHILD_REPORT"),
		fauxAssistantMessage("DONE"),
	]);
	await promptSession(p.sessionId, "Delegate.");
	expect((await toolTexts(p)).join("\n")).toContain("CHILD_REPORT");
	expect(pids()).toHaveLength(1);
	await removeSession(p.sessionId);
});

const notices = () =>
	requests.flatMap((request) => (request.kind === "notify" ? [request.message] : []));

test("status comes from omp's typed connection status without toasting it, and generations only grow", async () => {
	const p = await chat();
	const first = await refreshMcpStatus(p.sessionId, 5000);
	expect(first?.servers.find((server) => server.name === "fixture")).toMatchObject({
		state: "connected",
		toolCount: 4,
	});
	const second = await refreshMcpStatus(p.sessionId, 5000);
	expect(second?.generation ?? 0).toBeGreaterThan(first?.generation ?? 0);
	expect(notices().some((message) => message.startsWith("fixture:"))).toBe(false);
	const listed = await listMcpServers({
		workspaceId: p.workspaceId,
		cwd: p.cwd,
		project: undefined,
		waitMs: 5000,
	});
	expect(listed.servers.map((server) => [server.name, server.scope, server.transport])).toEqual([
		["fixture", "user", "stdio"],
	]);
	expect(listed.statuses.map((snapshot) => snapshot.sessionId)).toEqual([p.sessionId]);
	await removeSession(p.sessionId);
});

const SLOW_START = { MCP_FIXTURE_INITIALIZE_DELAY_MS: "1500" };

test("a chat reports its servers starting until omp connects them, from the moment it opens and again after each reload", async () => {
	writeMcpConfig(SLOW_START);
	const p = await chat();
	const opened = await listMcpServers({
		workspaceId: p.workspaceId,
		cwd: p.cwd,
		project: undefined,
		waitMs: 0,
	});
	expect(opened.statuses.map((snapshot) => snapshot.sessionId)).toEqual([p.sessionId]);
	const starting = opened.statuses[0]?.servers;
	expect(starting?.map((server) => [server.name, server.state])).toEqual([["fixture", "starting"]]);
	expect(starting?.[0]?.updatedAt).toBeGreaterThan(0);
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	const connected = await refreshMcpStatus(p.sessionId, 0);

	expect(await requestSessionReload(p.sessionId)).toBe("reloaded");
	const reloaded = await refreshMcpStatus(p.sessionId, 0);
	expect(reloaded?.servers.find((server) => server.name === "fixture")?.state).toBe("starting");
	expect(reloaded?.generation ?? 0).toBeGreaterThan(connected?.generation ?? 0);
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	await removeSession(p.sessionId);
}, 20_000);

test("a status capture takes only its own dispatch's notices, so the user's own /mcp prints in the chat once", async () => {
	const p = await chat();
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	requests = [];
	const typed = promptSession(p.sessionId, "/mcp");
	const captured: string[] = [];
	const dispatched = dispatchSessionMcpCommand(p.sessionId, "", (message) =>
		captured.push(message),
	);
	await Promise.all([typed, dispatched]);
	expect(captured).toHaveLength(1);
	expect(captured[0]).toStartWith("fixture: connected, 4 tools");
	expect(notices().filter((message) => message.startsWith("fixture:"))).toEqual(captured);
	await removeSession(p.sessionId);
}, 15_000);

test("reconnecting keeps the host's notices out of the chat and rejects with the failure", async () => {
	const p = await chat();
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	requests = [];
	await reconnectMcpServer(p.sessionId, "fixture");
	const refusal = (name: string) =>
		reconnectMcpServer(p.sessionId, name).then(
			() => null,
			(error: Error) => error.message,
		);
	expect(await refusal("nope")).toBe('No MCP server named "nope" is configured for this chat.');
	expect(await refusal("ghp_abcdefghijklmnop1234")).toBe(
		'No MCP server named "***" is configured for this chat.',
	);
	expect(notices()).toEqual([]);
	expect(await stateOf(p.sessionId, "fixture")).toBe("connected");
	await removeSession(p.sessionId);
});

test("disabling a server in one chat stops it at the reload and reads as disabled in this chat", async () => {
	const p = await chat();
	const [pid] = await waitFor(() => (pids().length > 0 ? pids() : undefined));
	expect(await setSessionMcpServerEnabled(p.sessionId, "fixture", false)).toBe("reloaded");
	await waitFor(() => !alive(pid as number), 6000);
	const snapshot = await refreshMcpStatus(p.sessionId, 5000);
	expect(snapshot?.servers.find((server) => server.name === "fixture")?.state).toBe(
		"disabled-in-chat",
	);
	expect(await setSessionMcpServerEnabled(p.sessionId, "fixture", false)).toBe("unchanged");
	expect(await setSessionMcpServerEnabled(p.sessionId, "fixture", true)).toBe("reloaded");
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	await removeSession(p.sessionId);
});

test("MCP enable and disable validate file provenance even for unchanged requests", async () => {
	const p = await chat();
	for (const enabled of [true, false]) {
		await expect(setSessionMcpServerEnabled(p.sessionId, "missing", enabled)).rejects.toMatchObject(
			{
				code: "MCP_CONFIG_INVALID",
			},
		);
	}
	await removeSession(p.sessionId);
});

test("a server that fails at startup lands in status; only clients without mcp.status still get the toast", async () => {
	writeMcpConfig({}, { broken: { command: join(root, "missing-binary"), exposure: "direct" } });
	const p = await chat();
	const snapshot = await waitFor(async () => {
		const current = await refreshMcpStatus(p.sessionId, 5000);
		return current?.servers.find((server) => server.name === "broken")?.state === "failed"
			? current
			: undefined;
	});
	expect(snapshot).toBeDefined();
	expect(notices().some((message) => message.startsWith("MCP servers need attention"))).toBe(false);
	const legacy = legacyRequests.find((request) => request.kind === "notify");
	expect(legacy?.kind === "notify" && legacy.message.startsWith("MCP servers need attention")).toBe(
		true,
	);
	await removeSession(p.sessionId);
});

const second = { command: process.execPath, args: [fixture], exposure: "direct" };
const stateOf = async (sessionId: string, name: string) =>
	(await refreshMcpStatus(sessionId, 5000))?.servers.find((server) => server.name === name)?.state;

test("only sessions whose effective config changed reload, and the chat resources list the servers", async () => {
	const a = await chat();
	const b = await chat();
	await waitFor(async () => (await stateOf(a.sessionId, "fixture")) === "connected");
	expect(await reconcileMcpSessions([a.sessionId, b.sessionId])).toEqual({});

	mkdirSync(join(a.cwd, ".omp"), { recursive: true });
	writeFileSync(join(a.cwd, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { repo: second } }));
	expect(await reconcileMcpSessions([a.sessionId, b.sessionId])).toEqual({});

	writeMcpConfig({}, { second });
	expect(await reconcileMcpSessions([a.sessionId, b.sessionId])).toEqual({
		[a.sessionId]: "reloaded",
		[b.sessionId]: "reloaded",
	});
	await waitFor(async () => (await stateOf(b.sessionId, "second")) === "connected");
	const resources = await getSessionResources(b.workspaceId, b.sessionId, b.cwd);
	expect(
		resources.mcpServers?.map((server) => [server.name, server.state, server.transport]),
	).toEqual([
		["fixture", "connected", "stdio"],
		["second", "connected", "stdio"],
	]);
	await removeSession(a.sessionId);
	await removeSession(b.sessionId);
});

test("a busy chat shows pending reload for the changed server and takes the change at settlement", async () => {
	const p = await chat();
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	faux.setResponses([fauxAssistantMessage("word ".repeat(3000))]);
	const turn = promptSession(p.sessionId, "Talk for a while.");
	await waitFor(() => getSessionState(p.sessionId).execution === "running");
	writeMcpConfig({}, { second });
	expect(await reconcileMcpSessions([p.sessionId])).toEqual({ [p.sessionId]: "deferred" });
	expect(await stateOf(p.sessionId, "second")).toBe("pending-reload");
	await turn;
	await waitFor(async () => (await stateOf(p.sessionId, "second")) === "connected");
	await removeSession(p.sessionId);
});

test("the user-file watcher creates omp's agent dir when it is missing and then picks up the file", async () => {
	const fresh = join(root, "fresh-agent");
	expect(existsSync(fresh)).toBe(false);
	const isolated = isolateAgentDir(fresh);
	const stop = watchUserMcpConfig();
	try {
		expect(existsSync(fresh)).toBe(true);
		const p = await chat();
		writeMcpConfig({}, {}, fresh);
		await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
		await removeSession(p.sessionId);
	} finally {
		stop();
		isolated.restore();
	}
});

test("the user-file watcher reloads live chats after an edit outside the app", async () => {
	const stop = watchUserMcpConfig();
	try {
		const p = await chat();
		await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
		writeMcpConfig({}, { second });
		await waitFor(async () => (await stateOf(p.sessionId, "second")) === "connected");
		await removeSession(p.sessionId);
	} finally {
		stop();
	}
});

const mcpResources = async (p: Awaited<ReturnType<typeof chat>>) =>
	(await getSessionResources(p.workspaceId, p.sessionId, p.cwd)).mcpServers;

function probeStarts(): string[] {
	return existsSync(probeMarker)
		? readFileSync(probeMarker, "utf8").split("\n").filter(Boolean)
		: [];
}

test("disabling a server in a busy chat reads as pending reload right away", async () => {
	const p = await chat();
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "connected");
	faux.setResponses([fauxAssistantMessage("word ".repeat(3000))]);
	const turn = promptSession(p.sessionId, "Talk for a while.");
	await waitFor(() => getSessionState(p.sessionId).execution === "running");
	expect(await setSessionMcpServerEnabled(p.sessionId, "fixture", false)).toBe("deferred");
	expect((await mcpResources(p))?.map((server) => [server.name, server.state])).toEqual([
		["fixture", "pending-reload"],
	]);
	await turn;
	await waitFor(async () => (await stateOf(p.sessionId, "fixture")) === "disabled-in-chat");
	await removeSession(p.sessionId);
});

test("results carry a durable, base64-free summary, and Full output reads only the recorded file", async () => {
	setSessionManagerFactory((cwd) => SessionManager.create(cwd, join(root, "sessions")));
	const p = await chat().finally(() =>
		setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd)),
	);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("mcp__fixture_rich", {}, { id: "rich" })),
		fauxAssistantMessage(fauxToolCall("mcp__fixture_big", {}, { id: "big" })),
		fauxAssistantMessage("DONE"),
	]);
	await promptSession(p.sessionId, "Use rich and big.");
	const { messages } = await getSessionMessages(p.sessionId, p.workspaceId, p.cwd);
	const resultOf = (toolCallId: string) =>
		messages.find((message) => message.role === "toolResult" && message.toolCallId === toolCallId);
	const rich = resultOf("rich");
	if (rich?.role !== "toolResult") throw new Error("missing rich result");
	expect((rich.details as { thinkrail?: unknown }).thinkrail).toEqual({
		blocks: [
			{ kind: "text", chars: 11 },
			{ kind: "image", mimeType: "image/png" },
			{ kind: "resource_link", uri: "file:///notes/a.md", name: "a.md", mimeType: "text/markdown" },
		],
		structuredContent: { rows: [{ id: 1, title: "first" }] },
	});
	expect(JSON.stringify(rich.details)).not.toContain("iVBORw0KGgo");

	const big = resultOf("big");
	if (big?.role !== "toolResult") throw new Error("missing big result");
	const fullOutputPath = (big.details as { fullOutputPath?: string }).fullOutputPath;
	expect(typeof fullOutputPath).toBe("string");
	const output = await readMcpToolOutput(p.workspaceId, p.sessionId, "big", p.cwd);
	expect(output.available && output.text.length).toBe("line of output\n".length * 20_000);
	expect(await readMcpToolOutput(p.workspaceId, p.sessionId, "rich", p.cwd)).toEqual({
		available: false,
		reason: "unavailable",
	});
	expect(await readMcpToolOutput(p.workspaceId, p.sessionId, "nope", p.cwd)).toEqual({
		available: false,
		reason: "unavailable",
	});
	rmSync(fullOutputPath as string, { force: true });
	expect(await readMcpToolOutput(p.workspaceId, p.sessionId, "big", p.cwd)).toEqual({
		available: false,
		reason: "expired",
	});
	await removeSession(p.sessionId);
});
