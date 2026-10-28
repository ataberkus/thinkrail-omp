import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionFactory,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
	createFauxCore,
	createFauxModelRegistry,
	fauxAssistantMessage,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";
import { childExtensionFactories } from "./extensions";
import {
	pendingNamingRule,
	SET_TITLE_TOOL_NAME,
	type SetTitleParams,
	setTitleExtension,
	setTitleToolHost,
} from "./titleTool";

const root = mkdtempSync(join(tmpdir(), "title-tool-"));
let agentDir: IsolatedAgentDir | undefined;

beforeAll(() => {
	agentDir = isolateAgentDir(join(root, "agent"));
});

afterAll(() => {
	agentDir?.restore();
	rmSync(root, { recursive: true, force: true });
});

afterEach(() => setTitleToolHost(null));

const faux = createFauxCore({ provider: "title-faux" });

async function withSession(
	extensions: ExtensionFactory[],
	run: (session: AgentSession) => Promise<void>,
): Promise<void> {
	const settings = Settings.isolated({});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const model = registerFaux(modelRegistry, faux);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(root),
		extensions,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	try {
		await run(session);
	} finally {
		await session.dispose();
	}
}

test("set_title delegates the write policy to the host handler and returns its verdict", async () => {
	await withSession([setTitleExtension], async (session) => {
		const calls: Array<[string, SetTitleParams]> = [];
		setTitleToolHost({
			apply: async (sessionId, params) => {
				calls.push([sessionId, params]);
				return "Chat title set. Workspace name kept (already named).";
			},
			workspaceNeedsName: () => false,
		});
		const params = {
			chat_title: "Ревью #567",
			workspace_name: "Review #567",
			branch: "review-567",
		};
		const result = await session.getToolByName(SET_TITLE_TOOL_NAME)?.execute("call-1", params);

		expect(calls).toEqual([[session.sessionManager.getSessionId(), params]]);
		expect(result?.content).toEqual([
			{ type: "text", text: "Chat title set. Workspace name kept (already named)." },
		]);
	});
});

test("the tool is top-level and its description names once-only, user-language, and the PR/issue form", async () => {
	await withSession([setTitleExtension], async (session) => {
		const tool = session.extensionRunner
			?.getAllRegisteredTools()
			.find((registered) => registered.definition.name === SET_TITLE_TOOL_NAME)?.definition;
		expect(tool?.loadMode).toBe("essential");
		const guidance = tool?.description ?? "";
		expect(guidance).toContain("once per conversation, with chat_title, workspace_name and branch");
		expect(guidance).toContain("language the user writes in");
		expect(guidance).toContain("<Verb> #<number> <its exact title>");
	});
});

test("the tool is registered for top-level sessions, never in a subagent child's factories", async () => {
	await withSession([setTitleExtension], async (session) => {
		const registered = session.extensionRunner
			?.getAllRegisteredTools()
			.filter((tool) => tool.extensionPath === "<inline-0>")
			.map((tool) => tool.definition.name);
		expect(registered).toEqual([SET_TITLE_TOOL_NAME]);
	});
	expect(childExtensionFactories()).not.toContain(setTitleExtension);
});

test("pendingNamingRule names exactly what is still unnamed, and vanishes once both are named", () => {
	const both = pendingNamingRule(true, true);
	expect(both).toContain("this chat has no title and its workspace has no name yet");
	expect(both).toContain("call set_title with chat_title, workspace_name and branch before");
	const chatOnly = pendingNamingRule(true, false);
	expect(chatOnly).toContain("this chat has no title yet");
	expect(chatOnly).toContain("call set_title with chat_title before");
	const workspaceOnly = pendingNamingRule(false, true);
	expect(workspaceOnly).toContain("its workspace has no name yet");
	expect(workspaceOnly).toContain("call set_title with workspace_name and branch before");
	expect(pendingNamingRule(false, false)).toBeNull();
});

test("the turn-start hook adds the pending-naming rule only while something is unnamed", async () => {
	await withSession([setTitleExtension], async (session) => {
		let workspaceUnnamed = true;
		setTitleToolHost({ apply: async () => "", workspaceNeedsName: () => workspaceUnnamed });
		const run = async (): Promise<string | undefined> => {
			let seen: string[] = [];
			faux.setResponses([
				(context) => {
					seen = context.systemPrompt ?? [];
					return fauxAssistantMessage("ok");
				},
			]);
			await session.prompt("Fix the login redirect.");
			await session.waitForIdle();
			return seen.find((block) => block.startsWith("Naming is still pending"));
		};

		expect(await run()).toContain("before your other tool calls");
		workspaceUnnamed = false;
		expect(await run()).toContain("this chat has no title yet");
		await session.sessionManager.setSessionName("Named", "user");
		expect(await run()).toBeUndefined();
	});
});
