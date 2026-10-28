import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtUiRequest, McpToolGrant } from "@thinkrail/contracts";
import { fauxAssistantMessage, fauxToolCall } from "pi-faux";
import {
	followUpSession,
	getSessionMessages,
	mcpSessionView,
	promptSession,
	setMcpPolicyResolver,
	setMcpToolGrantWriter,
	steerSession,
} from "./agentSessionManager";
import {
	MCP_CONFIRM_ALWAYS,
	MCP_CONFIRM_CHAT,
	MCP_CONFIRM_DENY,
	MCP_CONFIRM_ONCE,
	mcpPolicyOf,
} from "./mcp";
import { type McpHarness, startMcpHarness, stdioFixture } from "./mcp/fixtures/harness";
import { resolveExtUi, setExtUiPublisher } from "./webUiContext";

const WRITE = "mcp__probe_write_note";
const READ = "mcp__probe_echo";
const ALWAYS_TITLE =
	"Allow probe/write_note? It may change data.\nAlways allow trusts this tool in every chat of this project. Manage it in Settings › MCP servers.";
const ALL_OPTIONS = [MCP_CONFIRM_DENY, MCP_CONFIRM_ONCE, MCP_CONFIRM_CHAT, MCP_CONFIRM_ALWAYS];
let h: McpHarness;
let requests: ExtUiRequest[] = [];

function configure(server: Record<string, unknown> = {}): void {
	writeFileSync(
		join(h.agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				probe: { command: process.execPath, args: [stdioFixture], exposure: "direct", ...server },
			},
		}),
	);
}

beforeAll(async () => {
	h = await startMcpHarness("confirm");
	const tool = (name: string, text: string) =>
		[
			"  pi.registerTool({",
			`    name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, description: "probe",`,
			'    loadMode: "essential",',
			'    parameters: { type: "object", properties: {} },',
			`    execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(text)} }], details: {} }),`,
			"  });",
		].join("\n");
	writeFileSync(
		join(h.agentDir, "extensions", "mcp-probe.ts"),
		[
			"export default function probe(pi) {",
			tool("gated", "GATED"),
			'  pi.on("input", (event) => (event.text === "HANDLED ELSEWHERE" ? { handled: true } : undefined));',
			'  pi.registerCommand("ask-idle", { description: "probe", handler: async (_args, ctx) => {',
			'    await ctx.ui.input("Paste the code");',
			"  } });",
			'  pi.on("tool_call", async (event, ctx) => {',
			'    if (event.toolName !== "gated") return undefined;',
			'    const ok = await ctx.ui.confirm("Run gated?", "It is gated.");',
			'    return ok ? undefined : { block: true, reason: "not confirmed" };',
			"  });",
			"}",
			"",
		].join("\n"),
	);
	setExtUiPublisher((request) => requests.push(request));
});

beforeEach(() => {
	requests = [];
	configure();
});

afterAll(async () => {
	setExtUiPublisher(() => {});
	await h.teardown();
});

async function waitFor<T>(read: () => T | undefined, ms = 8000): Promise<T> {
	const until = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > until) throw new Error("condition timed out");
		await Bun.sleep(5);
	}
}

const selects = () => requests.filter((request) => request.kind === "select");

async function chat() {
	const p = await h.chat();
	await waitFor(() =>
		mcpSessionView(p.sessionId)?.runtime.every((server) => server.state === "connected")
			? true
			: undefined,
	);
	return p;
}

function callTools(...names: string[]) {
	h.faux.setResponses([
		...names.map((name, index) =>
			fauxAssistantMessage(fauxToolCall(name, { text: "x" }, { id: `call-${index}` })),
		),
		fauxAssistantMessage("DONE"),
		fauxAssistantMessage("DONE"),
	]);
}

async function toolResults(p: Awaited<ReturnType<typeof chat>>) {
	const { messages } = await getSessionMessages(p.sessionId, p.workspaceId, p.cwd);
	return messages.flatMap((message) =>
		message.role === "toolResult"
			? [
					{
						tool: message.toolName,
						isError: message.isError,
						text: message.content
							.map((block) => (block.type === "text" ? block.text : ""))
							.join(""),
					},
				]
			: [],
	);
}

async function answerNextSelect(value: string | null, index: number): Promise<ExtUiRequest> {
	const request = await waitFor(() => selects()[index]);
	resolveExtUi({ id: request.id, value });
	return request;
}

test("read-only MCP tools run unasked; others ask with Deny kept away from Allow in this chat", async () => {
	const p = await chat();
	callTools(READ, WRITE);
	const turn = promptSession(p.sessionId, "Use the tools.");
	const asked = await answerNextSelect(MCP_CONFIRM_ONCE, 0);
	await turn;
	expect(asked).toMatchObject({
		kind: "select",
		title: ALWAYS_TITLE,
		options: ALL_OPTIONS,
		toolCallId: "call-1",
	});
	expect(selects()).toHaveLength(1);
	expect(await toolResults(p)).toEqual([
		{ tool: READ, isError: false, text: "echo: x" },
		{ tool: WRITE, isError: false, text: "write_note: x" },
	]);
});

test("the approval carries the call's whole input, never a truncated preview", async () => {
	const p = await chat();
	const input = { text: "a ".repeat(300).trim(), ambiguous: false };
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall(WRITE, input, { id: "call-0" })),
		fauxAssistantMessage("DONE"),
	]);
	const turn = promptSession(p.sessionId, "Write it.");
	const asked = await answerNextSelect(MCP_CONFIRM_DENY, 0);
	await turn;
	expect(asked).toMatchObject({
		title: ALWAYS_TITLE,
		toolCallId: "call-0",
		toolInput: input,
	});
});

test("Allow once asks again next time; Allow in this chat stops asking for that tool in that chat", async () => {
	const p = await chat();
	callTools(WRITE, WRITE, WRITE);
	const turn = promptSession(p.sessionId, "Write three times.");
	await answerNextSelect(MCP_CONFIRM_ONCE, 0);
	await answerNextSelect(MCP_CONFIRM_CHAT, 1);
	await turn;
	expect(selects()).toHaveLength(2);
	expect((await toolResults(p)).map((result) => result.text)).toEqual([
		"write_note: x",
		"write_note: x",
		"write_note: x",
	]);

	const other = await chat();
	callTools(WRITE);
	const otherTurn = promptSession(other.sessionId, "Write.");
	await answerNextSelect(MCP_CONFIRM_ONCE, 2);
	await otherTurn;
});

test("Deny and a dismissed dialog both block the call with a reason", async () => {
	const p = await chat();
	callTools(WRITE, WRITE);
	const turn = promptSession(p.sessionId, "Write twice.");
	await answerNextSelect(MCP_CONFIRM_DENY, 0);
	await answerNextSelect(null, 1);
	await turn;
	const results = await toolResults(p);
	expect(results.map((result) => result.isError)).toEqual([true, true]);
	expect(results[0]?.text).toContain("denied");
	expect(results[1]?.text).toContain("did not confirm");
});

for (const [label, send] of [
	["steer", steerSession],
	["follow-up", followUpSession],
] as const) {
	test(`an accepted ${label} answers a pending confirmation: it is dismissed and the call blocked`, async () => {
		const p = await chat();
		callTools(WRITE);
		const turn = promptSession(p.sessionId, "Write.");
		const asked = await waitFor(() => selects()[0]);
		await send(p.sessionId, "Never mind, stop.");
		await turn;
		expect(requests).toContainEqual(expect.objectContaining({ id: asked.id, kind: "dismiss" }));
		const [result] = await toolResults(p);
		expect(result).toMatchObject({ tool: WRITE, isError: true });
		expect(result?.text).toContain("replied in the chat");
	});
}

test("a message an input extension handles answers no dialog, while or between turns", async () => {
	const p = await chat();
	callTools(WRITE);
	const turn = promptSession(p.sessionId, "Write.");
	const asked = await waitFor(() => selects()[0]);
	await followUpSession(p.sessionId, "HANDLED ELSEWHERE");
	await steerSession(p.sessionId, "HANDLED ELSEWHERE");
	expect(requests).not.toContainEqual(expect.objectContaining({ id: asked.id, kind: "dismiss" }));
	resolveExtUi({ id: asked.id, value: MCP_CONFIRM_ONCE });
	await turn;
	expect((await toolResults(p)).map((result) => result.text)).toEqual(["write_note: x"]);

	const command = promptSession(p.sessionId, "/ask-idle");
	const idle = await waitFor(() => requests.find((request) => request.kind === "input"));
	await promptSession(p.sessionId, "HANDLED ELSEWHERE");
	await followUpSession(p.sessionId, "HANDLED ELSEWHERE");
	expect(requests).not.toContainEqual(expect.objectContaining({ id: idle.id, kind: "dismiss" }));
	h.faux.setResponses([fauxAssistantMessage("OK")]);
	await promptSession(p.sessionId, "Never mind.");
	expect(requests).toContainEqual(expect.objectContaining({ id: idle.id, kind: "dismiss" }));
	await command;
});

test("Always allow saves a project grant that skips the question until the server's command changes", async () => {
	const grants: Record<string, McpToolGrant> = {};
	setMcpPolicyResolver(() => mcpPolicyOf({ mcpToolGrants: grants }));
	setMcpToolGrantWriter((_workspaceId, server, target, tool) => {
		grants[server] = { target, tools: [tool] };
	});
	const variant = (name: string) => configure({ args: [stdioFixture, "--variant", name] });
	try {
		variant("a");
		const first = await chat();
		callTools(WRITE);
		const firstTurn = promptSession(first.sessionId, "Send.");
		const asked = await answerNextSelect(MCP_CONFIRM_ALWAYS, 0);
		await firstTurn;
		expect(asked).toMatchObject({ title: ALWAYS_TITLE, options: ALL_OPTIONS });
		expect(grants.probe?.tools).toEqual([WRITE]);

		const second = await chat();
		callTools(WRITE);
		await promptSession(second.sessionId, "Send again.");
		expect(selects()).toHaveLength(1);
		expect((await toolResults(second)).map((result) => result.text)).toEqual(["write_note: x"]);

		variant("b");
		const third = await chat();
		callTools(WRITE);
		const thirdTurn = promptSession(third.sessionId, "Send once more.");
		await answerNextSelect(MCP_CONFIRM_ONCE, 1);
		await thirdTurn;
		expect(selects()).toHaveLength(2);
	} finally {
		rmSync(join(h.agentDir, "mcp.json"), { force: true });
		setMcpPolicyResolver(() => mcpPolicyOf(undefined));
		setMcpToolGrantWriter(() => {});
	}
});

test("a third-party gate's dialog names the one running tool call it is about", async () => {
	const p = await chat();
	callTools("gated");
	const turn = promptSession(p.sessionId, "Run the gated tool.");
	const asked = await waitFor(() => requests.find((request) => request.kind === "confirm"));
	expect(asked).toMatchObject({ kind: "confirm", title: "Run gated?", toolCallId: "call-0" });
	resolveExtUi({ id: asked.id, value: true });
	await turn;
	expect(await toolResults(p)).toEqual([{ tool: "gated", isError: false, text: "GATED" }]);
});

test("a deferred server's tools are mounted under xd:// while a direct server's tools are declared", async () => {
	const seenTools: string[][] = [];
	const respond = () =>
		h.faux.setResponses([
			(context) => {
				seenTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("OK");
			},
		]);
	const direct = await chat();
	respond();
	await promptSession(direct.sessionId, "Hi.");
	configure({ exposure: "deferred", toolExposure: { "write_*": "hidden" } });
	const deferred = await chat();
	respond();
	await promptSession(deferred.sessionId, "Hi.");
	expect(seenTools[0]).toEqual(expect.arrayContaining([READ, WRITE]));
	expect(seenTools[1]?.some((name) => name.startsWith("mcp__"))).toBe(false);
	callTools(WRITE);
	await promptSession(deferred.sessionId, "Write.");
	expect((await toolResults(deferred))[0]).toMatchObject({ tool: WRITE, isError: true });
});
