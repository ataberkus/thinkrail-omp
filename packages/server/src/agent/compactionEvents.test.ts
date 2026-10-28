import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSessionEvent,
	createAgentSession,
	type ExtensionFactory,
	SessionManager,
	Settings,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { waitForSessionSettlement } from "@oh-my-pi/pi-coding-agent/session/session-settle";
import { isTranscriptMessageRole } from "@thinkrail/contracts";
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

const MODEL = {
	id: "compaction-probe",
	name: "Compaction visibility probe",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 100,
};

interface ScenarioOptions {
	extensionCompaction: boolean;
	abortCompaction?: boolean;
	responses: FauxResponseStep[];
}

const COMPACTION_THRESHOLD = 20_000;
const PROBE_TOOL = "probe_output";
const probeParameters = z.object({});
const probeTool: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: PROBE_TOOL,
		label: PROBE_TOOL,
		description: "Returns a large block of text.",
		parameters: probeParameters,
		loadMode: "essential",
		execute: async () => ({
			content: [{ type: "text", text: "y".repeat(120_000) }],
			details: {},
		}),
	});
};
const toolTurn = () => fauxAssistantMessage(fauxToolCall(PROBE_TOOL, {}));

const root = mkdtempSync(join(tmpdir(), "thinkrail-compaction-events-"));
let isolated: IsolatedAgentDir | undefined;
let sequence = 0;

beforeAll(() => {
	isolated = isolateAgentDir(join(root, "agent"));
});

afterAll(() => {
	isolated?.restore();
	rmSync(root, { recursive: true, force: true });
});

async function runCompactionScenario({
	extensionCompaction,
	responses,
	abortCompaction,
}: ScenarioOptions): Promise<{
	events: AgentSessionEvent[];
	settled: boolean;
	contextTokens: number | undefined;
	callCount: number;
	messages: { role: string; summary?: string }[];
}> {
	const cwd = mkdtempSync(join(root, "cwd-"));
	const ambient = await createFauxModelRegistry();
	const ambientProviders = [
		...new Set(ambient.modelRegistry.getAvailable().map((available) => available.provider)),
	];
	const settings = Settings.isolated({
		disabledProviders: ambientProviders,
		"compaction.enabled": true,
		"compaction.methodOrder": ["soft"],
		"compaction.keepRecentTokens": 1,
		"compaction.thresholdTokens": COMPACTION_THRESHOLD,
		"compaction.midTurnEnabled": false,
		"compaction.asyncEnabled": false,
		"retry.enabled": false,
	});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const faux = createFauxCore({
		provider: `compaction-probe-${++sequence}`,
		models: [MODEL],
		tokensPerSecond: 100_000,
	});
	const model = registerFaux(modelRegistry, faux);
	const summarize: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "Earlier work summarized.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
	};
	faux.setResponses(responses);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(root, "agent"),
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(cwd),
		extensions: extensionCompaction ? [probeTool, summarize] : [probeTool],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => {
		events.push(event);
		if (abortCompaction && event.type === "auto_compaction_start") session.abortCompaction();
	});
	try {
		await session.prompt("x".repeat(5000));
		await session.waitForIdle();
		return {
			events,
			settled: await waitForSessionSettlement(session, { isCurrent: () => true }),
			contextTokens: session.getContextUsage()?.tokens,
			callCount: faux.state.callCount,
			messages: session.messages.map((message) => ({
				role: message.role,
				...("summary" in message ? { summary: String(message.summary) } : {}),
			})),
		};
	} finally {
		unsubscribe();
		await session.dispose();
	}
}

const isTerminalEnd = (event: AgentSessionEvent | undefined): boolean =>
	event?.type === "agent_end" && event.isTerminal === true;

test("threshold compaction after a completed response: visible lifecycle, no unsolicited continuation", async () => {
	const result = await runCompactionScenario({
		extensionCompaction: true,
		responses: [toolTurn(), fauxAssistantMessage("all done")],
	});

	expect(result.callCount).toBe(2);
	expect(result.events.filter((event) => event.type === "agent_start")).toHaveLength(1);

	const types = result.events.map((event) => event.type);
	const starts = result.events.filter((event) => event.type === "auto_compaction_start");
	const ends = result.events.filter((event) => event.type === "auto_compaction_end");
	expect(starts.map((event) => event.reason)).toEqual(["threshold"]);
	expect(ends).toHaveLength(1);
	const end = ends[0];
	expect(starts[0]?.action).toBeDefined();
	expect(end?.action).toBe(starts[0]?.action);
	expect(end?.aborted).toBe(false);
	expect(end?.willRetry).toBe(false);
	expect(end?.errorMessage).toBeUndefined();
	const tokensBefore = end?.result?.tokensBefore ?? 0;
	expect(tokensBefore).toBeGreaterThan(COMPACTION_THRESHOLD);
	expect(result.contextTokens ?? Number.POSITIVE_INFINITY).toBeLessThan(tokensBefore);
	expect(types.lastIndexOf("turn_end")).toBeLessThan(types.indexOf("auto_compaction_start"));
	expect(types.indexOf("auto_compaction_start")).toBeLessThan(types.indexOf("auto_compaction_end"));
	expect(isTerminalEnd(result.events.at(-1))).toBe(true);
	expect(result.settled).toBe(true);

	expect(result.messages.some((message) => message.role === "compactionSummary")).toBe(true);
	expect(isTranscriptMessageRole("compactionSummary")).toBe(true);
});

test("cancelled compaction settles without persisting a summary", async () => {
	const result = await runCompactionScenario({
		extensionCompaction: false,
		abortCompaction: true,
		responses: [toolTurn(), fauxAssistantMessage("all done"), fauxAssistantMessage("partial")],
	});
	const ends = result.events.filter((event) => event.type === "auto_compaction_end");
	expect(ends).toHaveLength(1);
	expect(ends[0]?.aborted).toBe(true);
	expect(ends[0]?.result).toBeUndefined();
	expect(ends[0]?.willRetry).toBe(false);
	expect(result.messages.some((message) => message.role === "compactionSummary")).toBe(false);
	expect(isTerminalEnd(result.events.at(-1))).toBe(true);
	expect(result.settled).toBe(true);
});

test("omp keeps a length-limited summary as a successful compaction (upstream canary)", async () => {
	const result = await runCompactionScenario({
		extensionCompaction: false,
		responses: [
			toolTurn(),
			fauxAssistantMessage("all done"),
			fauxAssistantMessage("partial", { stopReason: "length" }),
		],
	});
	const ends = result.events.filter((event) => event.type === "auto_compaction_end");
	expect(ends).toHaveLength(1);
	expect(ends[0]?.errorMessage).toBeUndefined();
	expect(ends[0]?.willRetry).toBe(false);
	expect(ends[0]?.result).toBeDefined();
	const summary = result.messages.find((message) => message.role === "compactionSummary");
	expect(summary?.summary).toContain("partial");
	expect(isTerminalEnd(result.events.at(-1))).toBe(true);
	expect(result.settled).toBe(true);
});

test("a failed compaction emits a visible error end and does not loop", async () => {
	const result = await runCompactionScenario({
		extensionCompaction: false,
		responses: [
			toolTurn(),
			fauxAssistantMessage("all done"),
			() => {
				throw new Error("compaction summarizer down");
			},
		],
	});

	expect(result.callCount).toBe(3);

	expect(result.events.filter((event) => event.type === "agent_start")).toHaveLength(1);
	const ends = result.events.filter((event) => event.type === "auto_compaction_end");
	expect(ends).toHaveLength(1);
	const end = ends[0];
	expect(end?.aborted).toBe(false);
	expect(end?.willRetry).toBe(false);
	expect(end?.result).toBeUndefined();
	expect(end?.errorMessage).toContain("compaction summarizer down");
	expect(isTerminalEnd(result.events.at(-1))).toBe(true);
	expect(result.settled).toBe(true);

	expect(result.messages.some((message) => message.role === "compactionSummary")).toBe(false);
});
