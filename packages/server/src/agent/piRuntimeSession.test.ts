import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";
import {
	activatePiRuntimeGeneration,
	configurePiRuntime,
	configurePiRuntimeGenerationInitializer,
	getPiRuntimeGeneration,
	preparePiRuntimeGeneration,
} from "./piRuntime";
import { isolatedHostSettings } from "./piSettings";

const REPLY = "The ported runtime streamed this reply in several deltas.";
const root = mkdtempSync(join(tmpdir(), "thinkrail-runtime-session-"));
const cwd = mkdtempSync(join(root, "project-"));
const faux = fauxProvider({ provider: "runtime-faux", models: [{ id: "runtime-faux-1" }] });
let agentDir: IsolatedAgentDir | undefined;

beforeAll(() => {
	agentDir = isolateAgentDir(join(root, "agent"));
	configurePiRuntime(null);
	configurePiRuntimeGenerationInitializer((runtime) =>
		runtime.registerNativeProvider(faux.provider),
	);
});

afterAll(() => {
	configurePiRuntime(null);
	configurePiRuntimeGenerationInitializer();
	agentDir?.restore();
	rmSync(root, { recursive: true, force: true });
});

test("a chat started on a prepared runtime generation streams a faux reply and disposes cleanly", async () => {
	const prepared = await preparePiRuntimeGeneration([]);
	if (prepared.outcome !== "prepared") throw new Error("the runtime generation failed to prepare");
	activatePiRuntimeGeneration(prepared.generation);
	const { runtime } = await getPiRuntimeGeneration();
	expect(runtime).toBe(prepared.generation.runtime);
	expect(prepared.generation.providerStatusIds.has("runtime-faux")).toBe(true);

	const model = registerFaux(runtime.modelRegistry, faux, { apiKey: "faux" });
	faux.setResponses([fauxAssistantMessage(REPLY)]);
	const shutdowns: string[] = [];
	const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(root, "agent"),
		settings: isolatedHostSettings().settings,
		authStorage: runtime.authStorage,
		modelRegistry: runtime.modelRegistry,
		sessionManager,
		model,
		extensions: [(pi) => pi.on("session_shutdown", (event) => void shutdowns.push(event.type))],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		hasUI: false,
	});

	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => void events.push(event));
	await session.prompt("Say something.");
	await session.waitForIdle();
	unsubscribe();

	const deltas = events.flatMap((event) =>
		event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
			? [event.assistantMessageEvent.delta]
			: [],
	);
	expect(deltas.length).toBeGreaterThan(1);
	expect(deltas.join("")).toBe(REPLY);
	expect(events.map((event) => event.type)).toContain("agent_end");
	expect(faux.getPendingResponseCount()).toBe(0);

	const file = sessionManager.getSessionFile();
	if (!file) throw new Error("the chat was not persisted");
	await session.dispose();
	await session.dispose();
	expect(session.isDisposed).toBe(true);
	expect(shutdowns).toEqual(["session_shutdown"]);
	const persisted = readFileSync(file, "utf8");
	expect(persisted).toContain("Say something.");
	expect(persisted).toContain(REPLY);

	const reopened = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
	try {
		expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	} finally {
		await reopened.close();
	}
});
