import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
	createFauxModelRegistry,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "pi-faux";
import factory, { WORKFLOW_BLOCK, WORKFLOW_RULE, WORKFLOW_SECTION } from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "pi-thinkrail-workflow-"));
let agentDirIsolation: IsolatedAgentDir | undefined;

beforeAll(() => {
	agentDirIsolation = isolateAgentDir(join(root, "agent"));
});

afterAll(() => {
	agentDirIsolation?.restore();
	rmSync(root, { recursive: true, force: true });
});

async function promptsSeen(
	start: (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => Promise<unknown>,
	extensions: ExtensionFactory[] = [factory],
	seedBase = false,
): Promise<string[][]> {
	const settings = Settings.isolated({});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const faux: FauxProviderHandle = fauxProvider({ provider: "faux-workflow" });
	const model = registerFaux(modelRegistry, faux);
	const seen: string[][] = [];
	faux.setResponses([
		(context) => {
			seen.push([...(context.systemPrompt ?? [])]);
			return fauxAssistantMessage("ok");
		},
	]);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(root),
		extensions,
		...(seedBase ? { systemPrompt: (base: string[]) => [...base, WORKFLOW_BLOCK] } : {}),
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
		await start(session);
		await session.waitForIdle();
	} finally {
		await session.dispose();
	}
	return seen;
}

describe("pi-thinkrail-workflow extension", () => {
	test("contributes the workflow rule as its own prompt section", async () => {
		const seen = await promptsSeen((session) => session.prompt("do the thing"));
		expect(seen).toHaveLength(1);
		expect(seen[0]?.filter((part) => part.includes(WORKFLOW_RULE))).toEqual([WORKFLOW_BLOCK]);
	});

	test("reaches runs started by a custom message when the host seeds it into the base prompt", async () => {
		const seen = await promptsSeen(
			(session) =>
				session.sendCustomMessage(
					{ customType: "test", content: "continue", display: false },
					{ triggerTurn: true },
				),
			[factory],
			true,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.filter((part) => part === WORKFLOW_BLOCK)).toEqual([WORKFLOW_BLOCK]);
	});

	test("does not repeat a rule the host already seeded into the base prompt", async () => {
		const seen = await promptsSeen((session) => session.prompt("do the thing"), [factory], true);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.filter((part) => part.includes(WORKFLOW_RULE))).toEqual([WORKFLOW_BLOCK]);
	});

	test("omp renders the rule as its own tagged block at the tail of the prompt", async () => {
		const later = (pi: ExtensionAPI): void => {
			pi.on("before_agent_start", (event) => {
				expect(event.systemPrompt.at(-1)).toBe(WORKFLOW_BLOCK);
			});
		};
		const seen = await promptsSeen((session) => session.prompt("do the thing"), [factory, later]);
		const prompt = seen[0] ?? [];
		const block = `<${WORKFLOW_SECTION}>\n${WORKFLOW_RULE}\n</${WORKFLOW_SECTION}>`;

		expect(WORKFLOW_BLOCK).toBe(block);
		expect(prompt.length).toBeGreaterThan(1);
		expect(prompt.findIndex((part) => part.includes("<workstation>"))).toBeLessThan(
			prompt.indexOf(block),
		);
		expect(prompt.at(-1)).toBe(block);
		expect(prompt.join("\n")).toEndWith(block);
	});

	test("classifies every GitHub merge state before declaring a PR ready", () => {
		const checks = readFileSync(
			new URL("./skills/shipping-a-pr/checks.md", import.meta.url),
			"utf8",
		);
		for (const state of [
			"UNKNOWN",
			"BEHIND",
			"DIRTY",
			"UNSTABLE",
			"BLOCKED",
			"CLEAN",
			"HAS_HOOKS",
		]) {
			expect(checks).toContain(`\`${state}\``);
		}
		expect(checks).toContain("isDraft");
		expect(checks).toContain("reviewDecision");
		expect(checks).not.toContain("Any other computed state");
	});

	test("creates PRs without duplicate verification or unsolicited monitoring", () => {
		const skill = readFileSync(new URL("./skills/shipping-a-pr/SKILL.md", import.meta.url), "utf8");
		const creating = readFileSync(
			new URL("./skills/shipping-a-pr/creating.md", import.meta.url),
			"utf8",
		);
		expect(skill).toContain("Create a PR — the work is finished | `creating.md` | snapshot");
		expect(skill).toContain("A push never upgrades the mode by");
		expect(creating).toContain("Do not rerun a passing command merely because PR creation");
		expect(creating).toContain("defaults to snapshot mode");
	});

	test("ties reused verification and empty check rollups to observed final state", () => {
		const skill = readFileSync(new URL("./skills/shipping-a-pr/SKILL.md", import.meta.url), "utf8");
		const creating = readFileSync(
			new URL("./skills/shipping-a-pr/creating.md", import.meta.url),
			"utf8",
		);
		const comments = readFileSync(
			new URL("./skills/shipping-a-pr/review-comments.md", import.meta.url),
			"utf8",
		);
		const checks = readFileSync(
			new URL("./skills/shipping-a-pr/checks.md", import.meta.url),
			"utf8",
		);
		expect(skill).toContain("Before every code-affecting push");
		expect(creating).toContain("repeat gates 3–5 against the new head");
		expect(comments).toContain("final-tree verification rule");
		expect(checks).toContain("no checks currently reported");
		expect(checks).toContain("Never infer “no checks configured” from one empty rollup");
	});

	test("reapplies title edits after a concurrent GitHub change", () => {
		const body = readFileSync(new URL("./skills/shipping-a-pr/body.md", import.meta.url), "utf8");
		expect(body).toContain("immediately re-fetch the current title");
		expect(body).toContain("reapply");
		expect(body).toContain("requested mutation to that fresh title");
	});
});
