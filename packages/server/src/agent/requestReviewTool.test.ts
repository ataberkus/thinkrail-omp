import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import {
	createFauxCore,
	createFauxModelRegistry,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";
import {
	createRequestReviewTool,
	REQUEST_REVIEW_TOOL_NAME,
	requestReviewExtension,
} from "./requestReviewTool";

const root = mkdtempSync(join(tmpdir(), "request-review-"));
let agentDir: IsolatedAgentDir | undefined;

beforeAll(() => {
	agentDir = isolateAgentDir(join(root, "agent"));
});

afterAll(() => {
	agentDir?.restore();
	rmSync(root, { recursive: true, force: true });
});

test("the tool guidance is policy-neutral — it defers to the tool result's next action", () => {
	const guidance = createRequestReviewTool().description.toLowerCase();
	expect(guidance).toContain("follow the next action");
	expect(guidance).not.toContain("request_review again before moving to the next step");
	expect(guidance).not.toContain("address every finding");
});

test("requestReviewExtension always registers the tool top-level (the agent-review gate is a live active-tool toggle, not registration)", async () => {
	const settings = Settings.isolated({});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const model = registerFaux(modelRegistry, createFauxCore({ provider: "request-review-faux" }));
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(root),
		extensions: [requestReviewExtension],
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
		const registered = session.extensionRunner
			?.getAllRegisteredTools()
			.filter((tool) => tool.extensionPath === "<inline-0>")
			.map((tool) => [tool.definition.name, tool.definition.loadMode]);
		expect(registered).toEqual([[REQUEST_REVIEW_TOOL_NAME, "essential"]]);
	} finally {
		await session.dispose();
	}
});
