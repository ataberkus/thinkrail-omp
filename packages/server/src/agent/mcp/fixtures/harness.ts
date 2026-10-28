import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { createFauxCore, type FauxCore, isolateAgentDir } from "pi-faux";
import {
	createSession,
	disposeAllSessions,
	setSessionManagerFactory,
	settleSessionsForShutdown,
} from "../../agentSessionManager";
import { ModelRuntime } from "../../modelRuntime";
import { configurePiRuntime } from "../../piRuntime";

export const stdioFixture = join(import.meta.dir, "stdioServer.ts");

export interface McpHarness {
	root: string;
	agentDir: string;
	faux: FauxCore;
	runtime: ModelRuntime;
	chatIn(workspaceId: string, cwd: string): Promise<{ sessionId: string }>;
	chat(prefix?: string): Promise<{ workspaceId: string; cwd: string; sessionId: string }>;
	teardown(): Promise<void>;
}

export async function startMcpHarness(provider: string): Promise<McpHarness> {
	const model = {
		id: provider,
		name: provider,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
	const faux = createFauxCore({
		provider,
		api: provider,
		models: [model],
		tokensPerSecond: 4000,
	});
	const saved = { data: process.env.THINKRAIL_DATA_DIR, offline: process.env.PI_OFFLINE };
	const root = mkdtempSync(join(tmpdir(), `${provider}-`));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	const isolated = isolateAgentDir(agentDir);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.PI_OFFLINE = "1";
	const runtime = await ModelRuntime.create({ inMemoryCredentials: true, modelsPath: null });
	runtime.registerProvider(provider, {
		api: faux.api,
		apiKey: "test",
		baseUrl: "http://faux.local",
		streamSimple: faux.streamSimple,
		models: [{ ...model, api: faux.api }],
	});
	configurePiRuntime(runtime);
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
	let sequence = 0;
	return {
		root,
		agentDir,
		faux,
		runtime,
		chatIn: (workspaceId, cwd) =>
			createSession({ workspaceId, cwd, model: { ...model, provider, thinkingLevels: ["off"] } }),
		async chat(prefix = provider) {
			const workspaceId = `${prefix}-${++sequence}`;
			const cwd = mkdtempSync(join(root, "cwd-"));
			const { sessionId } = await createSession({
				workspaceId,
				cwd,
				model: { ...model, provider, thinkingLevels: ["off"] },
			});
			return { workspaceId, cwd, sessionId };
		},
		async teardown() {
			await settleSessionsForShutdown();
			disposeAllSessions();
			configurePiRuntime(null);
			setSessionManagerFactory((cwd) => SessionManager.create(cwd));
			isolated.restore();
			if (saved.data === undefined) delete process.env.THINKRAIL_DATA_DIR;
			else process.env.THINKRAIL_DATA_DIR = saved.data;
			if (saved.offline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = saved.offline;
			rmSync(root, { recursive: true, force: true });
		},
	};
}
