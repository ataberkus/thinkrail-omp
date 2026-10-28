import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "pi-faux";
import { getSessionMessages, sessionRunSnapshot } from "./agentSessionManager";
import { type McpHarness, startMcpHarness } from "./mcp/fixtures/harness";
import { lookupBlockReason, type ReadOnlyAgentStep, runReadOnlyAgent } from "./readOnlyAgent";

let h: McpHarness;
beforeAll(async () => {
	h = await startMcpHarness("faux-readonly");
});
afterAll(() => h.teardown());

interface ToolResultView {
	error: boolean;
	text: string;
}

const toolResults = (messages: readonly Message[]): ToolResultView[] =>
	messages.flatMap((m) =>
		m.role === "toolResult"
			? [
					{
						error: m.isError === true,
						text: m.content.map((c) => ("text" in c ? c.text : "")).join(""),
					},
				]
			: [],
	);

test("lookupBlockReason keeps lookups inside the folder", () => {
	const cwd = join("/", "repo");
	expect(lookupBlockReason("read", { path: "src/a.ts:10-20" }, cwd)).toBeNull();
	expect(lookupBlockReason("grep", { pattern: "x" }, cwd)).toBeNull();
	expect(lookupBlockReason("glob", { path: "src/**/*.ts;!**/*.test.ts" }, cwd)).toBeNull();
	expect(lookupBlockReason("read", { path: join(cwd, "a.ts") }, cwd)).toBeNull();
	for (const path of [
		"../x",
		"src/../../x",
		join("/", "etc", "passwd"),
		"~/.ssh",
		"skill://x",
		"https://a.b",
	])
		expect(lookupBlockReason("read", { path }, cwd)).not.toBeNull();
	expect(lookupBlockReason("grep", { pattern: "x", path: "src;../other" }, cwd)).not.toBeNull();
	expect(lookupBlockReason("read", { path: "config/.env.local" }, cwd)).not.toBeNull();
	expect(lookupBlockReason("read", { path: ".env.example" }, cwd)).toBeNull();
	expect(lookupBlockReason("grep", { pattern: "x", gitignore: false }, cwd)).not.toBeNull();
	expect(lookupBlockReason("bash", { command: "ls" }, cwd)).not.toBeNull();
});

test("runs read-only in the chat folder, blocks escapes and over-budget lookups, reports steps", async () => {
	const { sessionId, cwd, workspaceId } = await h.chat();
	writeFileSync(join(cwd, "a.txt"), "ALPHA_CONTENT");
	let tools: string[] = [];
	let systemPrompt = "";
	let final: ToolResultView[] = [];
	h.faux.setResponses([
		(context) => {
			tools = (context.tools ?? []).map((t) => t.name).sort();
			systemPrompt = String(context.systemPrompt);
			return fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "a.txt" }, { id: "r1" }),
					fauxToolCall("read", { path: "../escape.txt" }, { id: "r2" }),
					fauxToolCall("glob", { path: "*.txt" }, { id: "g1" }),
				],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			final = toolResults(context.messages);
			return fauxAssistantMessage("REWRITTEN");
		},
	]);
	const steps: ReadOnlyAgentStep[] = [];
	const text = await runReadOnlyAgent({
		sessionId,
		system: "ENHANCER_SYSTEM",
		prompt: "draft",
		maxLookups: 2,
		signal: new AbortController().signal,
		onStep: (s) => steps.push(s),
	});
	expect(text).toBe("REWRITTEN");
	expect(tools).toEqual(["glob", "grep", "read"]);
	expect(systemPrompt).toContain("ENHANCER_SYSTEM");
	expect(steps).toEqual([{ tool: "read", target: "a.txt" }]);
	expect(final[0]).toEqual({ error: false, text: expect.stringContaining("ALPHA_CONTENT") });
	expect(final[1]?.error).toBe(true);
	expect(final[1]?.text).toContain("inside this repository");
	expect(final[2]?.error).toBe(true);
	expect(final[2]?.text).toContain("budget");
	const { messages } = await getSessionMessages(sessionId, workspaceId, cwd);
	expect(messages).toHaveLength(0);
});

test("abort rejects the run", async () => {
	const { sessionId } = await h.chat();
	const controller = new AbortController();
	h.faux.setResponses([
		() => {
			controller.abort();
			return fauxAssistantMessage("LATE");
		},
	]);
	await expect(
		runReadOnlyAgent({
			sessionId,
			system: "S",
			prompt: "draft",
			maxLookups: 8,
			signal: controller.signal,
		}),
	).rejects.toThrow();
});

test("a configured model role replaces the chat's model and is the one named; an unset one keeps it", async () => {
	const role = createFauxCore({
		provider: "faux-role",
		api: "faux-role",
		models: [{ id: "role-model" }],
	});
	h.runtime.registerProvider("faux-role", {
		api: role.api,
		apiKey: "test",
		baseUrl: "http://faux.local",
		streamSimple: role.streamSimple,
		models: [
			{
				id: "role-model",
				name: "role-model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
				api: role.api,
			},
		],
	});
	const { sessionId } = await h.chat();
	const named: string[] = [];
	const run = (modelRole: string) =>
		runReadOnlyAgent({
			sessionId,
			modelRole,
			system: "S",
			prompt: "d",
			maxLookups: 8,
			signal: new AbortController().signal,
			onModel: (model) => named.push(model),
		});
	sessionRunSnapshot(sessionId)?.settings.setModelRole("enhance", "faux-role/role-model");
	role.setResponses([fauxAssistantMessage("FROM_ROLE")]);
	h.faux.setResponses([fauxAssistantMessage("FROM_CHAT")]);
	expect(await run("enhance")).toBe("FROM_ROLE");
	expect(await run("unset-role")).toBe("FROM_CHAT");
	expect(named[0]).toBe("role-model");
	expect(named).toHaveLength(2);
	expect(named[1]).not.toBe("role-model");
});

test("an unknown chat yields null", async () => {
	expect(
		await runReadOnlyAgent({
			sessionId: "nope",
			system: "S",
			prompt: "d",
			maxLookups: 8,
			signal: new AbortController().signal,
		}),
	).toBeNull();
});
