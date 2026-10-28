import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AgentSessionEvent,
	createAgentSession,
	DEFAULT_MAX_BYTES,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
	createFauxCore,
	createFauxModelRegistry,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";
import specGraphExtension from "pi-spec-graph";

const root = mkdtempSync(join(tmpdir(), "thinkrail-tool-output-"));
let agentDir: IsolatedAgentDir | undefined;

beforeAll(() => {
	agentDir = isolateAgentDir(join(root, "agent"));
});

afterAll(() => {
	agentDir?.restore();
	rmSync(root, { recursive: true, force: true });
});

async function scenario(responses: FauxResponseStep[]) {
	const cwd = mkdtempSync(join(root, "cwd-"));
	mkdirSync(join(root, "agent"), { recursive: true });
	const source = `---\nid: sample\ntype: module-design\n---\n${`needle ${"x".repeat(1000)}\n`.repeat(240)}`;
	writeFileSync(join(cwd, "SPEC.md"), source);
	const faux = createFauxCore({
		provider: "tool-output-probe",
		models: [
			{ id: "tool-output-probe", input: ["text"], contextWindow: 1_000_000, maxTokens: 100 },
		],
		tokensPerSecond: 100_000,
		tokenSize: { min: 1024, max: 1024 },
	});
	const settings = Settings.isolated({});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const model = registerFaux(modelRegistry, faux);
	const requests: { toolTextBytes: number[]; toolErrors: boolean[]; content: string }[] = [];
	faux.setResponses(
		responses.map((response) => (context, options, state, activeModel) => {
			const results = context.messages.flatMap((message) =>
				message.role === "toolResult" ? [message] : [],
			);
			requests.push({
				toolTextBytes: results.map((message) =>
					Buffer.byteLength(
						message.content
							.flatMap((block) => (block.type === "text" ? [block.text] : []))
							.join("\n"),
					),
				),
				toolErrors: results.map((message) => message.isError),
				content: JSON.stringify(context.messages.map((message) => message.content)),
			});
			return typeof response === "function"
				? response(context, options, state, activeModel)
				: response;
		}),
	);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(root, "agent"),
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(cwd),
		extensions: [specGraphExtension],
		disableExtensionDiscovery: true,
		toolNames: ["read"],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => events.push(event));
	try {
		await session.prompt("Run the tool.");
		await session.waitForIdle();
		return { events, requests, callCount: faux.state.callCount };
	} finally {
		unsubscribe();
		await session.dispose();
		for (const event of events) {
			if (event.type !== "tool_execution_end") continue;
			const details = event.result.details as { output?: { fullOutputPath?: string } } | undefined;
			if (details?.output?.fullOutputPath)
				rmSync(dirname(details.output.fullOutputPath), { recursive: true, force: true });
		}
	}
}

const settledTerminally = (events: AgentSessionEvent[]): boolean => {
	const last = events.findLast((event) => event.type === "agent_end");
	return last?.type === "agent_end" && last.isTerminal === true;
};

test("omp receives bounded native and spec-search results", async () => {
	for (const [name, args] of [
		["read", { path: "SPEC.md" }],
		["spec_grep", { pattern: "needle" }],
	] as const) {
		const result = await scenario([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		expect(result.callCount).toBe(2);
		const request = result.requests[1];
		expect(request?.toolTextBytes).toHaveLength(1);
		expect(request?.toolErrors).toEqual([false]);
		expect(request?.content).toContain("needle");
		expect(request?.toolTextBytes[0]).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(settledTerminally(result.events)).toBe(true);
	}
});

test("omp dispatches an oversized tool error with its failure flag and bounded error text", async () => {
	const result = await scenario([
		fauxAssistantMessage(fauxToolCall("spec_get", { id: "x".repeat(60000) }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("The lookup failed"),
	]);
	expect(result.callCount).toBe(2);
	expect(result.requests[1]?.toolErrors).toEqual([true]);
	expect(result.requests[1]?.content).toContain("Error:");
	expect(result.requests[1]?.toolTextBytes[0]).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	expect(settledTerminally(result.events)).toBe(true);
});
