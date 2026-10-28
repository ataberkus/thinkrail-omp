import { describe, expect, test } from "bun:test";
import type { McpServerStatus, McpServerSummary } from "@thinkrail/contracts";
import { validateMcpServerConfig } from "./config";
import {
	deriveMcpServerStatuses,
	formatMcpRuntime,
	type McpRuntimeStatus,
	McpRuntimeTracker,
	reportMcpRuntime,
} from "./status";

const http = (url: string) => ({ type: "http", url });
const stdio = { type: "stdio" };

function source(connected: Record<string, number>, connecting: string[] = []) {
	return {
		connectionStatus: (name: string) =>
			name in connected
				? ("connected" as const)
				: connecting.includes(name)
					? ("connecting" as const)
					: ("disconnected" as const),
		toolCount: (name: string) => connected[name] ?? 0,
	};
}

describe("omp's typed connection status", () => {
	test("every state from omp's connection events and per-server connection status", () => {
		const tracker = new McpRuntimeTracker();
		tracker.observe({
			type: "connecting",
			serverNames: ["docs", "empty", "linear", "flaky", "slow", "broken"],
		});
		tracker.observe({ type: "failed", serverName: "linear", error: "HTTP 401: Unauthorized" });
		tracker.observe({ type: "failed", serverName: "broken", error: "spawn npx ENOENT" });
		const configs = new Map<string, { enabled?: boolean; type?: string; url?: string }>([
			["docs", http("https://docs.example/mcp")],
			["empty", stdio],
			["linear", http("https://linear.example/mcp")],
			["off", { ...stdio, enabled: false }],
			["flaky", stdio],
			["slow", stdio],
			["cold", stdio],
			["broken", stdio],
		]);
		const statuses = tracker.statuses(configs, source({ docs: 2, empty: 0 }, ["slow"]));
		const state = (name: string) => statuses.find((status) => status.name === name);
		expect(state("docs")).toMatchObject({ state: "connected", toolCount: 2 });
		expect(state("empty")).toMatchObject({ state: "connected", toolCount: 0 });
		expect(state("linear")?.state).toBe("needs-sign-in");
		expect(state("off")?.state).toBe("disabled");
		expect(state("flaky")?.state).toBe("disconnected");
		expect(state("slow")?.state).toBe("starting");
		expect(state("cold")?.state).toBe("starting");
		expect(state("broken")).toMatchObject({ state: "failed", detail: "spawn npx ENOENT" });
		expect(tracker.statuses(configs, null).map((status) => status.state)).toEqual([
			"starting",
			"starting",
			"starting",
			"disabled",
			"starting",
			"starting",
			"starting",
			"starting",
		]);
	});

	test("multiline config diagnostics keep healthy server rows and remain redacted", () => {
		const error = validateMcpServerConfig("bad\nname", { command: "unused" });
		expect(typeof error).toBe("string");
		const parsed = reportMcpRuntime(
			[
				{ name: "first", state: "connected", toolCount: 1 },
				{ name: "second", state: "connected", toolCount: 2 },
			],
			[`/fixture/mcp.json: ${error}\n    token=private-value`],
		);
		expect([...parsed.servers.keys()]).toEqual(["first", "second"]);
		expect(parsed.configErrors).toEqual([`/fixture/mcp.json: ${error}\n    token=***`]);
	});

	test("the empty report has no rows, and the chat's /mcp text lists each state", () => {
		expect(reportMcpRuntime([]).servers.size).toBe(0);
		expect(formatMcpRuntime([])).toBe("No MCP servers configured.");
		const statuses: McpRuntimeStatus[] = [
			{ name: "docs", state: "connected", toolCount: 2 },
			{ name: "broken", state: "failed", detail: "spawn ENOENT\nexit 1" },
		];
		expect(formatMcpRuntime(statuses)).toBe(
			"docs: connected, 2 tools\nbroken: failed\n    spawn ENOENT\n    exit 1",
		);
	});

	test("details are redacted: omp reports connection errors and HTTP bodies verbatim", () => {
		const tracker = new McpRuntimeTracker();
		tracker.observe({
			type: "failed",
			serverName: "remote",
			error:
				'MCP HTTP request failed with status 400: {"error":"rejected","api_key":"sk-live-abcdefgh1234"}',
		});
		tracker.observe({
			type: "failed",
			serverName: "local",
			error:
				"Connection closed\nGITHUB_TOKEN=ghp_abcdefghijklmnop1234 POST https://ada:pw@api.example/mcp",
		});
		const parsed = reportMcpRuntime(
			tracker.statuses(
				new Map([
					["remote", http("https://remote.example/mcp")],
					["local", stdio],
				]),
				source({}),
			),
		);
		expect(parsed.servers.get("remote")).toMatchObject({
			state: "failed",
			detail: 'MCP HTTP request failed with status 400: {"error":"rejected","api_key":"***"}',
		});
		expect(parsed.servers.get("local")?.detail).toBe(
			"Connection closed\nGITHUB_TOKEN=*** POST https://***:***@api.example/mcp",
		);
	});

	test("a startup failure lasts until omp reports the server connected again", () => {
		const tracker = new McpRuntimeTracker();
		const configs = new Map([["docs", http("https://docs.example/mcp")]]);
		tracker.observe({ type: "failed", serverName: "docs", error: "fetch failed" });
		expect(tracker.statuses(configs, source({}))[0]).toMatchObject({
			state: "failed",
			detail: "fetch failed",
		});
		tracker.observe({ type: "reconnecting", serverName: "docs" });
		expect(tracker.statuses(configs, source({}, ["docs"]))[0]?.state).toBe("starting");
		tracker.observe({ type: "connected", serverName: "docs" });
		expect(tracker.statuses(configs, source({ docs: 3 }))[0]).toEqual({
			name: "docs",
			state: "connected",
			toolCount: 3,
		});
		expect(tracker.statuses(configs, source({}))[0]?.state).toBe("disconnected");
	});
});

const summary = (over: Partial<McpServerSummary> & { name: string }): McpServerSummary => ({
	scope: "user",
	source: "/agent/mcp.json",
	fingerprint: "rendered",
	transport: "http",
	endpoint: "https://x",
	exposure: "deferred",
	effectiveExposure: "deferred",
	enabled: true,
	oauth: false,
	...over,
});

test("statuses explain what pi does not run and keep the last report when pi did not answer", () => {
	const summaries = [
		summary({ name: "chat-off" }),
		summary({ name: "project-off", projectOverride: { enabled: false } }),
		summary({ name: "repo", scope: "project", approval: { state: "pending", fingerprint: "f" } }),
		summary({ name: "invalid", configError: 'server "invalid" needs either "command" or "url"' }),
	];
	const reported = reportMcpRuntime([
		{ name: "chat-off", state: "disabled" },
		{ name: "project-off", state: "disabled" },
	]);
	const derived = deriveMcpServerStatuses({
		summaries,
		reported,
		disabledInChat: new Set(["chat-off"]),
		previous: [],
		now: 1,
	});
	expect(Object.fromEntries(derived.map((status) => [status.name, status.state]))).toEqual({
		"chat-off": "disabled-in-chat",
		"project-off": "disabled-in-project",
		repo: "pending-approval",
		invalid: "invalid-config",
	});
	const previous: McpServerStatus[] = [
		{ name: "chat-off", state: "connected", toolCount: 3, updatedAt: 1 },
	];
	const stale = deriveMcpServerStatuses({
		summaries: [summary({ name: "chat-off" })],
		reported: null,
		disabledInChat: new Set(),
		previous,
		now: 2,
	});
	expect(stale).toEqual(previous);
});
