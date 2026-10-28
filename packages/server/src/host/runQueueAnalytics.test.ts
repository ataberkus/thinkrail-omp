import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	createFauxCore,
	fauxAssistantMessage,
	type IsolatedAgentDir,
	isolateAgentDir,
} from "pi-faux";
import {
	configurePiRuntime,
	createSession,
	disposeAllSessions,
	getSessionState,
	ModelRuntime,
	setSessionCreatedPublisher,
	setSessionManagerFactory,
	setSessionPublisher,
	toWireModel,
} from "../agent";
import {
	initializeAnalytics,
	resetAnalyticsForTests,
	setAdditionalAnalyticsEnabled,
	shutdownAnalytics,
} from "../analytics";
import { saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import { handleRequest } from "./handlers";
import { runObservation } from "./runAnalytics";

const TEST_KEY = "phc_test";

let directory: string;
let isolatedAgentDir: IsolatedAgentDir | undefined;
const saved = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	PI_OFFLINE: process.env.PI_OFFLINE,
};

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-queue-analytics-"));
	process.env.THINKRAIL_DATA_DIR = directory;
	isolatedAgentDir = isolateAgentDir(join(directory, "pi"));
	process.env.PI_OFFLINE = "1";
	resetConfigCache();
	runObservation.reset();
	setSessionManagerFactory(() => SessionManager.inMemory());
	setSessionCreatedPublisher(() => {});
	setSessionPublisher(({ sessionId, event }) => runObservation.observe(sessionId, event));
});

afterEach(async () => {
	disposeAllSessions();
	await shutdownAnalytics();
	resetAnalyticsForTests();
	runObservation.reset();
	configurePiRuntime(null);
	setSessionPublisher(() => {});
	resetConfigCache();
	isolatedAgentDir?.restore();
	isolatedAgentDir = undefined;
	rmSync(directory, { recursive: true, force: true });
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function untilIdle(sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (getSessionState(sessionId).execution === "idle") return;
		await Bun.sleep(5);
	}
	throw new Error("session did not become idle");
}

test.each([
	"clear",
	"remove",
	"restore-on-abort",
] as const)("%s removes a parked pre-consent intent before a fresh consented run", async (method) => {
	const model = {
		id: "queue-analytics",
		name: "Queue analytics",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
	const provider = createFauxCore({
		provider: "queue-analytics",
		api: "queue-analytics",
		models: [model],
		tokensPerSecond: 2000,
	});
	provider.setResponses([fauxAssistantMessage("Complete")]);
	const runtime = await ModelRuntime.create({
		inMemoryCredentials: true,
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("queue-analytics", {
		api: provider.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: provider.streamSimple,
		models: [{ ...model, api: provider.api }],
	});
	configurePiRuntime(runtime);
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			kind: "default",
			name: "Test",
			branch: "main",
			baseBranch: "main",
			worktreePath: directory,
		},
	]);
	const events: { event: string; properties: Record<string, unknown> }[] = [];
	initializeAnalytics({
		posthogApiKey: TEST_KEY,
		additionalEnabled: false,
		env: {},
		fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			events.push(...JSON.parse(String(init?.body)).batch);
			return new Response("{}");
		}) as typeof fetch,
	});
	const settled = new Promise<void>((resolve) =>
		setSessionPublisher(({ sessionId, event }) => {
			runObservation.observe(sessionId, event);
			if (event.type === "agent_settled") resolve();
		}),
	);
	const session = await createSession({
		cwd: directory,
		workspaceId: "workspace",
		model: toWireModel(provider.getModel()),
	});
	const { sessionId } = session;
	const context = { clientKey: "client" };
	await handleRequest("session.steer", { sessionId, text: "discard this private input" }, context);
	if (method === "clear") await handleRequest("session.clearQueue", { sessionId }, context);
	else if (method === "remove") {
		await handleRequest("session.removeQueued", { sessionId, kind: "steering", index: 0 }, context);
	} else {
		await handleRequest("session.abort", { sessionId, restoreQueue: true }, context);
	}
	await untilIdle(sessionId);
	setAdditionalAnalyticsEnabled(true);
	await handleRequest("session.prompt", { sessionId, text: "fresh private input" }, context);
	await settled;
	await shutdownAnalytics();
	const runs = events.filter((event) => event.event.startsWith("agent_run_"));
	expect(runs.map((event) => event.event)).toEqual(["agent_run_started", "agent_run_settled"]);
	for (const event of runs) expect(event.properties.origin).toBe("user");
	expect(JSON.stringify(events)).not.toContain("private input");
});
