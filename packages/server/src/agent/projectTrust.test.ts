import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { ProjectResourceKind } from "@thinkrail/contracts";
import {
	createFauxCore,
	fauxAssistantMessage,
	type IsolatedAgentDir,
	isolateAgentDir,
} from "pi-faux";
import {
	applyPiResourceTrust,
	createSession,
	disposeAllSessions,
	getSessionCommands,
	getSessionState,
	liveParentContext,
	promptSession,
	reloadSessionResources,
	setSessionManagerFactory,
	setSkillAdmissionResolver,
	settleSessionsForShutdown,
} from "./agentSessionManager";
import { delegationServiceFor } from "./delegation";
import { ModelRuntime } from "./modelRuntime";
import { configurePiRuntime } from "./piRuntime";
import { projectTrustSummary } from "./projectTrust";
import { admissionContextFor } from "./skillAdmission";

const faux = createFauxCore({
	provider: "trust",
	api: "trust",
	models: [
		{ id: "trust", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096 },
	],
	tokensPerSecond: 40,
});
const saved = {
	data: process.env.THINKRAIL_DATA_DIR,
	offline: process.env.PI_OFFLINE,
};
const root = mkdtempSync(join(tmpdir(), "project-trust-"));
const agentDir = join(root, "agent");
const trustedWorkspaces = new Set<string>();
let sequence = 0;
let isolatedAgentDir: IsolatedAgentDir | undefined;

beforeAll(async () => {
	isolatedAgentDir = isolateAgentDir(agentDir);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.PI_OFFLINE = "1";
	mkdirSync(agentDir, { recursive: true });
	const runtime = await ModelRuntime.create({ inMemoryCredentials: true, modelsPath: null });
	runtime.registerProvider("trust", faux.providerConfig());
	configurePiRuntime(runtime);
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
	setSkillAdmissionResolver((workspaceId) =>
		admissionContextFor({
			piResourceTrust: trustedWorkspaces.has(workspaceId) ? "granted" : "untrusted",
		}),
	);
});

afterAll(async () => {
	await settleSessionsForShutdown();
	disposeAllSessions();
	configurePiRuntime(null);
	setSessionManagerFactory((cwd) => SessionManager.create(cwd));
	setSkillAdmissionResolver(() => admissionContextFor(undefined));
	isolatedAgentDir?.restore();
	if (saved.data === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = saved.data;
	if (saved.offline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = saved.offline;
	rmSync(root, { recursive: true, force: true });
});

async function waitFor(read: () => boolean, ms = 8000): Promise<void> {
	const until = Date.now() + ms;
	while (!read()) {
		if (Date.now() > until) throw new Error("condition timed out");
		await Bun.sleep(10);
	}
}

function projectCwd(): string {
	const cwd = mkdtempSync(join(root, "cwd-"));
	mkdirSync(join(cwd, ".omp", "prompts"), { recursive: true });
	writeFileSync(
		join(cwd, ".omp", "prompts", "native-kickoff.md"),
		"---\ndescription: n\n---\nGo\n",
	);
	return cwd;
}

async function projectSession(): Promise<{ workspaceId: string; sessionId: string }> {
	const workspaceId = `trust-${++sequence}`;
	const { sessionId } = await createSession({ workspaceId, cwd: projectCwd() });
	return { workspaceId, sessionId };
}

const hasNativeTemplate = (sessionId: string): boolean =>
	getSessionCommands(sessionId).some((command) => command.name === "native-kickoff");

test("the trust summary names each kind of the project's own resources omp loads from it, and counts project MCP entries", async () => {
	const project = (files: Record<string, string>): string => {
		const cwd = mkdtempSync(join(root, "summary-"));
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(cwd, path, ".."), { recursive: true });
			writeFileSync(join(cwd, path), content);
		}
		return cwd;
	};
	expect(await projectTrustSummary(project({ "README.md": "# plain\n" }))).toEqual({
		aliasSkills: [],
		piResources: [],
		mcpServers: 0,
	});
	const cases: Array<[ProjectResourceKind, string, Record<string, string>]> = [
		["extensions", "extension-modules", { ".omp/extensions/x.ts": "export default () => {};\n" }],
		["extensions", "hooks", { ".omp/hooks/pre/guard.ts": "export default () => {};\n" }],
		["extensions", "tools", { ".omp/tools/probe/index.ts": "export default () => [];\n" }],
		["settings", "settings", { ".omp/settings.json": "{}\n" }],
		["settings", "settings", { ".omp/config.yml": "theme: dark\n" }],
		["skills", "skills", { ".omp/skills/s/SKILL.md": "---\nname: s\ndescription: d\n---\n" }],
		["skills", "skills", { ".agents/skills/s/SKILL.md": "---\nname: s\ndescription: d\n---\n" }],
		["prompts", "prompts", { ".omp/prompts/kickoff.md": "Go\n" }],
		["systemPrompt", "system-prompt", { ".omp/SYSTEM.md": "You are.\n" }],
		["systemPrompt", "system-prompt", { ".omp/SYSTEM_TEMPLATE.md": "You are {{cwd}}.\n" }],
		["systemPrompt", "rules", { ".omp/RULES.md": "Be brief.\n" }],
		[
			"systemPrompt",
			"rules",
			{ ".omp/rules/style.md": "---\nalwaysApply: true\n---\nBe brief.\n" },
		],
	];
	for (const [kind, capability, files] of cases) {
		const cwd = project(files);
		const loaded = await loadCapability(capability, { cwd, agentDir });
		const fromProject = loaded.all.filter(
			(item) => item._source.level === "project" && item._source.path.startsWith(realpathSync(cwd)),
		);
		expect({ files, loaded: fromProject.length > 0 }).toEqual({ files, loaded: true });
		expect((await projectTrustSummary(cwd)).piResources).toEqual([kind]);
	}
	const definitions = project({
		".agents/agents/repo-reviewer.md":
			"---\nname: repo-reviewer\ndescription: Reviews\n---\n\nReview.\n",
		".omp/extensions/x.ts": "export default () => {};\n",
	});
	expect((await projectTrustSummary(definitions)).piResources.sort()).toEqual([
		"extensions",
		"subagents",
	]);
	expect(
		await projectTrustSummary(
			project({
				".omp/mcp.json": JSON.stringify({
					mcpServers: { docs: { url: "https://docs.example/mcp" }, linear: { enabled: false } },
				}),
			}),
		),
	).toEqual({ aliasSkills: [], piResources: [], mcpServers: 2 });
});

test("an untrusted project's native resources stay out until a grant reaches the live session", async () => {
	const { workspaceId, sessionId } = await projectSession();
	expect(hasNativeTemplate(sessionId)).toBe(false);
	expect(await applyPiResourceTrust([workspaceId])).toEqual({});

	trustedWorkspaces.add(workspaceId);
	expect(await applyPiResourceTrust(["some-other-workspace"])).toEqual({});
	expect(await applyPiResourceTrust([workspaceId])).toEqual({ [sessionId]: "reloaded" });
	expect(hasNativeTemplate(sessionId)).toBe(true);
	expect(await applyPiResourceTrust([workspaceId])).toEqual({});

	trustedWorkspaces.delete(workspaceId);
	expect(await applyPiResourceTrust([workspaceId])).toEqual({ [sessionId]: "reloaded" });
	expect(hasNativeTemplate(sessionId)).toBe(false);
});

test("every reload applies the project's current trust, and a busy session takes it at settlement", async () => {
	const first = await projectSession();
	trustedWorkspaces.add(first.workspaceId);
	await reloadSessionResources(first.sessionId);
	expect(hasNativeTemplate(first.sessionId)).toBe(true);

	const busy = await projectSession();
	faux.setResponses([fauxAssistantMessage("word ".repeat(60))]);
	const turn = promptSession(busy.sessionId, "Say many words.");
	await waitFor(() => getSessionState(busy.sessionId).execution === "running");
	trustedWorkspaces.add(busy.workspaceId);
	expect(await applyPiResourceTrust([busy.workspaceId])).toEqual({ [busy.sessionId]: "deferred" });
	expect(hasNativeTemplate(busy.sessionId)).toBe(false);
	await turn;
	await waitFor(() => hasNativeTemplate(busy.sessionId));
});

test("a session whose trust changed while it was opening reloads into the new trust before it is returned", async () => {
	const hook = globalThis as typeof globalThis & { __projectTrustFlip?: () => void };
	const flipPath = join(agentDir, "extensions", "trust-flip.ts");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(
		flipPath,
		"export default function flip(pi) { pi.on('session_start', () => { globalThis.__projectTrustFlip?.(); }); }\n",
	);
	const workspaceId = `trust-${++sequence}`;
	hook.__projectTrustFlip = () => trustedWorkspaces.add(workspaceId);
	try {
		const { sessionId } = await createSession({ workspaceId, cwd: projectCwd() });
		expect(hasNativeTemplate(sessionId)).toBe(true);
	} finally {
		delete hook.__projectTrustFlip;
		rmSync(flipPath, { force: true });
	}
});

test("a child derives no more trust than its parent has loaded or the project record allows", async () => {
	const childTrust = (sessionId: string) => liveParentContext(sessionId)?.isProjectTrusted?.();
	const busy = await projectSession();
	faux.setResponses([fauxAssistantMessage("word ".repeat(60))]);
	const turn = promptSession(busy.sessionId, "Say many words.");
	await waitFor(() => getSessionState(busy.sessionId).execution === "running");
	trustedWorkspaces.add(busy.workspaceId);
	expect(await applyPiResourceTrust([busy.workspaceId])).toEqual({ [busy.sessionId]: "deferred" });
	expect(childTrust(busy.sessionId)).toBe(false);
	await turn;
	await waitFor(() => hasNativeTemplate(busy.sessionId));
	expect(childTrust(busy.sessionId)).toBe(true);

	trustedWorkspaces.delete(busy.workspaceId);
	expect(childTrust(busy.sessionId)).toBe(false);
	expect(await applyPiResourceTrust([busy.workspaceId])).toEqual({ [busy.sessionId]: "reloaded" });
});

test("revoking trust stops the live subagents that were created under it before it reports", async () => {
	const p = await projectSession();
	trustedWorkspaces.add(p.workspaceId);
	await reloadSessionResources(p.sessionId);
	faux.setResponses([
		async (_context, streamOptions) => {
			await new Promise<void>((resolve) => {
				const signal = streamOptions?.signal;
				if (!signal) return;
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("CHILD_DONE");
		},
	]);
	const child = await delegationServiceFor(p.workspaceId).createChild({
		parent: p.sessionId,
		visibility: "hidden",
		info: { createdBy: "test" },
		session: {},
	});
	const run = child.runQueued("Keep going until trust is revoked.");
	await waitFor(() => child.snapshot?.status === "running");

	trustedWorkspaces.delete(p.workspaceId);
	expect(await applyPiResourceTrust([p.workspaceId])).toEqual({ [p.sessionId]: "reloaded" });
	expect(child.snapshot?.status).toBe("aborted");
	expect(child.snapshot?.details.abortReason).toBe("user");
	expect((await run).status).toBe("aborted");
	expect(hasNativeTemplate(p.sessionId)).toBe(false);
	expect(await applyPiResourceTrust([p.workspaceId])).toEqual({});
});
