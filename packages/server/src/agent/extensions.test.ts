import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { createFauxCore, createFauxModelRegistry, isolateAgentDir, registerFaux } from "pi-faux";
import specGraphExtension from "pi-spec-graph";
import { registryInlineExtensions, registryToolOwner } from "../extensions";
import {
	buildSessionResources,
	childBaseExtensionFactories,
	childExtensionFactories,
	disabledExtensions,
	listProjectAliasSkillNames,
	listSkillCommands,
	setDisabledExtensionsResolver,
} from "./extensions";
import { oversizedImageGuard } from "./imageGuard";
import { loadHostSettings } from "./piSettings";
import type { SkillAdmissionContext } from "./skillAdmission";

function ctx(trusted: boolean, acknowledged: string[] = []): SkillAdmissionContext {
	return {
		trusted,
		piResourceTrusted: trusted,
		acknowledged,
		disabled: [],
		disabledGroups: [],
		overrides: {},
	};
}

function stubSkillEnv(home: string, agentDir: string): () => void {
	const names = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME"];
	const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	process.env.HOME = home;
	delete process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CODEX_HOME;
	delete process.env.GEMINI_CLI_HOME;
	const isolated = isolateAgentDir(agentDir);
	return () => {
		isolated.restore();
		restoreEnvironment(original);
	};
}

function writeSkill(root: string, name: string, description: string): void {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nPortable fixture.\n`,
	);
}

function restoreEnvironment(original: Record<string, string | undefined>): void {
	for (const [name, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

describe("listSkillCommands", () => {
	it("shares omp precedence/provenance and does not execute extensions", async () => {
		const root = mkdtempSync(join(tmpdir(), "thinkrail-skill-catalog-"));
		const project = join(root, "project");
		const home = join(root, "home");
		const agentDir = join(root, "pi-agent");
		const marker = join(root, "extension-executed");
		mkdirSync(project, { recursive: true });
		mkdirSync(home, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const restore = stubSkillEnv(home, agentDir);

		try {
			const configuredRoot = join(root, "configured-skills");
			const nativeRoot = join(project, ".omp", "skills");
			const projectRoot = join(project, ".claude", "skills");
			const personalRoot = join(home, ".claude", "skills");
			writeSkill(configuredRoot, "configured-wins", "configured description");
			writeSkill(projectRoot, "configured-wins", "project alias must lose");
			writeFileSync(
				join(agentDir, "config.yml"),
				`skills:\n  customDirectories:\n    - ${JSON.stringify(configuredRoot)}\n`,
			);
			writeSkill(nativeRoot, "native-wins", "native description");
			writeSkill(projectRoot, "native-wins", "alias must lose");
			writeSkill(projectRoot, "personal-wins", "project alias must lose");
			writeSkill(personalRoot, "personal-wins", "personal description");
			writeSkill(personalRoot, "personal-only", "personal description");
			writeSkill(join(project, ".github", "skills"), "project-copilot", "copilot project");
			writeSkill(join(project, ".gemini", "skills"), "project-gemini", "gemini project");
			writeSkill(join(home, ".codex", "skills"), "personal-codex", "codex personal");
			writeSkill(join(home, ".copilot", "skills"), "personal-copilot", "copilot personal");
			writeSkill(join(home, ".gemini", "skills"), "personal-gemini", "gemini personal");
			writeSkill(personalRoot, "brainstorming", "personal brainstorming override");

			const invalidDir = join(projectRoot, "invalid");
			mkdirSync(invalidDir, { recursive: true });
			writeFileSync(join(invalidDir, "SKILL.md"), "# no frontmatter\n");

			const extensionDir = join(project, ".omp", "extensions");
			mkdirSync(extensionDir, { recursive: true });
			writeFileSync(
				join(extensionDir, "probe.ts"),
				`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport default () => {};\n`,
			);

			const commands = await listSkillCommands(
				project,
				ctx(true, await listProjectAliasSkillNames(project)),
			);
			const byName = (name: string) => commands.find((command) => command.name === `skill:${name}`);

			expect(byName("configured-wins")?.description).toBe("configured description");
			expect(byName("configured-wins")?.sourceInfo.scope).toBe("user");
			expect(byName("native-wins")?.description).toBe("native description");
			expect(byName("native-wins")?.sourceInfo.scope).toBe("project");
			expect(byName("personal-wins")?.description).toBe("personal description");
			expect(byName("personal-wins")?.sourceInfo).toMatchObject({
				source: "claude",
				scope: "user",
			});
			expect(byName("personal-only")?.sourceInfo).toMatchObject({
				source: "claude",
				scope: "user",
			});
			expect(byName("project-copilot")?.sourceInfo).toMatchObject({
				source: "github-copilot",
				scope: "project",
			});
			expect(byName("project-gemini")?.sourceInfo).toMatchObject({
				source: "gemini",
				scope: "project",
			});
			expect(byName("personal-codex")?.sourceInfo).toMatchObject({
				source: "codex",
				scope: "user",
			});
			expect(byName("personal-copilot")?.sourceInfo).toMatchObject({
				source: "github-copilot",
				scope: "user",
			});
			expect(byName("personal-gemini")?.sourceInfo).toMatchObject({
				source: "gemini",
				scope: "user",
			});
			expect(byName("brainstorming")).toBeDefined();
			expect(byName("brainstorming")?.description).not.toBe("personal brainstorming override");
			expect(byName("invalid")).toBeUndefined();
			expect(existsSync(marker)).toBe(false);
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("withholds project-scoped aliases until the project is trusted", async () => {
		const root = mkdtempSync(join(tmpdir(), "thinkrail-skill-trust-"));
		const project = join(root, "project");
		const home = join(root, "home");
		const agentDir = join(root, "pi-agent");
		mkdirSync(project, { recursive: true });
		mkdirSync(home, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const restore = stubSkillEnv(home, agentDir);

		try {
			writeSkill(join(project, ".claude", "skills"), "repo-alias", "committed repo skill");
			writeSkill(join(project, ".omp", "skills"), "repo-native", "omp-native repo skill");
			writeSkill(join(home, ".claude", "skills"), "personal-skill", "personal skill");

			const untrusted = await listSkillCommands(project, ctx(false));
			expect(untrusted.some((command) => command.name === "skill:repo-alias")).toBe(false);
			expect(untrusted.some((command) => command.name === "skill:personal-skill")).toBe(true);
			expect(untrusted.some((command) => command.name === "skill:repo-native")).toBe(false);
			const nativeOnly = await listSkillCommands(project, {
				...ctx(false),
				piResourceTrusted: true,
			});
			expect(nativeOnly.some((command) => command.name === "skill:repo-native")).toBe(true);
			expect(nativeOnly.some((command) => command.name === "skill:repo-alias")).toBe(false);

			const trusted = await listSkillCommands(
				project,
				ctx(true, await listProjectAliasSkillNames(project)),
			);
			expect(trusted.some((command) => command.name === "skill:repo-alias")).toBe(true);
			expect(trusted.some((command) => command.name === "skill:repo-native")).toBe(true);
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not serve a stale catalog when only disabledGroups differs", async () => {
		const root = mkdtempSync(join(tmpdir(), "thinkrail-skill-groups-"));
		const project = join(root, "project");
		const home = join(root, "home");
		const agentDir = join(root, "pi-agent");
		mkdirSync(project, { recursive: true });
		mkdirSync(home, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const restore = stubSkillEnv(home, agentDir);

		try {
			writeSkill(join(home, ".claude", "skills"), "personal-widget", "personal skill");

			const enabled = await listSkillCommands(project, {
				trusted: true,
				piResourceTrusted: true,
				acknowledged: [],
				disabled: [],
				disabledGroups: [],
				overrides: {},
			});
			expect(enabled.some((command) => command.name === "skill:personal-widget")).toBe(true);

			const groupOff = await listSkillCommands(project, {
				trusted: true,
				piResourceTrusted: true,
				acknowledged: [],
				disabled: [],
				disabledGroups: ["personal"],
				overrides: {},
			});
			expect(groupOff.some((command) => command.name === "skill:personal-widget")).toBe(false);
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

const faux = createFauxCore({ provider: "resources-faux" });

async function resourcesFor(
	project: string,
	projectTrusted: boolean,
	getAdmission: () => SkillAdmissionContext,
	excludedExtensionPaths: readonly string[] = [],
) {
	const { settings } = await loadHostSettings(project, projectTrusted);
	const resources = await buildSessionResources({
		cwd: project,
		settings,
		projectTrusted,
		getAdmission,
		excludedExtensionPaths,
	});
	return { settings, resources };
}

async function withSession<T>(
	project: string,
	agentDir: string,
	resolved: Awaited<ReturnType<typeof resourcesFor>>,
	run: (session: AgentSession) => Promise<T> | T,
): Promise<T> {
	const { authStorage, modelRegistry } = await createFauxModelRegistry(resolved.settings);
	const model = registerFaux(modelRegistry, faux);
	const { session } = await createAgentSession({
		cwd: project,
		agentDir,
		settings: resolved.settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(project),
		contextFiles: [],
		enableMCP: false,
		hasUI: false,
		...resolved.resources,
	});
	try {
		return await run(session);
	} finally {
		await session.dispose();
	}
}

function scratch(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const project = join(root, "project");
	const home = join(root, "home");
	const agentDir = join(root, "pi-agent");
	mkdirSync(project, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { root, project, home, agentDir };
}

describe("buildSessionResources", () => {
	for (const excluding of [false, true]) {
		it(`runs a project's .omp/extensions code only under project trust (exclusion branch: ${excluding})`, async () => {
			const { root, project, home, agentDir } = scratch("thinkrail-project-extension-");
			const generationArtifact = join(agentDir, "extensions", "generation.ts");
			const repoCode = join(project, ".omp", "extensions", "repo-code.ts");
			const loads = `__thinkrailProjectExtensionLoads_${excluding}`;
			const counters = globalThis as typeof globalThis & Record<string, number | undefined>;
			mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(generationArtifact, "export default function generation() {}\n");
			writeFileSync(
				repoCode,
				`export default function repoCode() { globalThis.${loads} = (globalThis.${loads} ?? 0) + 1; }\n`,
			);
			const restore = stubSkillEnv(home, agentDir);
			const open = async (projectTrusted: boolean) => {
				const resolved = await resourcesFor(
					project,
					projectTrusted,
					() => ({ ...ctx(false), piResourceTrusted: projectTrusted }),
					excluding ? [generationArtifact] : [],
				);
				const paths = resolved.resources.preloadedExtensionPaths ?? [];
				expect(paths.includes(generationArtifact)).toBe(!excluding);
				return withSession(project, agentDir, resolved, (session) => ({
					listed: paths.some((path) => path.endsWith("repo-code.ts")),
					loaded: (session.extensionRunner?.getExtensionPaths() ?? []).some((path) =>
						path.endsWith("repo-code.ts"),
					),
				}));
			};
			try {
				expect(await open(false)).toEqual({ listed: false, loaded: false });
				expect(counters[loads]).toBeUndefined();

				expect(await open(true)).toEqual({ listed: true, loaded: true });
				expect(counters[loads]).toBe(1);

				expect(await open(false)).toEqual({ listed: false, loaded: false });
				expect(counters[loads]).toBe(1);
			} finally {
				delete counters[loads];
				restore();
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("lists a project's prompt templates and custom tools only under project trust", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-project-resources-");
		mkdirSync(join(project, ".omp", "prompts"), { recursive: true });
		writeFileSync(
			join(project, ".omp", "prompts", "repo-kickoff.md"),
			"---\ndescription: d\n---\nGo\n",
		);
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(join(agentDir, "prompts", "own-kickoff.md"), "---\ndescription: d\n---\nGo\n");
		mkdirSync(join(project, ".omp", "tools", "repo-tool"), { recursive: true });
		writeFileSync(
			join(project, ".omp", "tools", "repo-tool", "index.ts"),
			"export default () => [];\n",
		);
		const restore = stubSkillEnv(home, agentDir);
		const listed = async (projectTrusted: boolean) => {
			const { resources } = await resourcesFor(project, projectTrusted, () => ctx(projectTrusted));
			return {
				prompts: (resources.promptTemplates ?? []).map((template) => template.name).sort(),
				tools: (resources.preloadedCustomToolPaths ?? []).some((entry) =>
					entry.path.includes("repo-tool"),
				),
			};
		};
		try {
			expect(await listed(false)).toEqual({ prompts: ["own-kickoff"], tools: false });
			expect(await listed(true)).toEqual({ prompts: ["own-kickoff", "repo-kickoff"], tools: true });
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("offers the bundled skills and turns omp's own discovery off for every listed resource", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-bundled-");
		const restore = stubSkillEnv(home, agentDir);
		try {
			const { resources } = await resourcesFor(project, false, () => ctx(false));
			expect((resources.skills ?? []).some((skill) => skill.name === "brainstorming")).toBe(true);
			expect(resources.disableExtensionDiscovery).toBe(true);
			expect(resources.slashCommands).toEqual([]);
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("re-reads admission on every build, so a group toggle applies to the next reopened chat", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-skill-reload-");
		const restore = stubSkillEnv(home, agentDir);

		try {
			writeSkill(join(home, ".claude", "skills"), "reload-widget", "personal skill");

			let admission: SkillAdmissionContext = {
				trusted: true,
				piResourceTrusted: true,
				acknowledged: [],
				disabled: [],
				disabledGroups: [],
				overrides: {},
			};
			const hasWidget = async () => {
				const { resources } = await resourcesFor(project, true, () => admission);
				return (resources.skills ?? []).some((skill) => skill.name === "reload-widget");
			};

			expect(await hasWidget()).toBe(true);

			admission = { ...admission, disabledGroups: ["personal"] };
			expect(await hasWidget()).toBe(false);
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a rebuild picks up a compatibility dir created after the first build", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-skill-newdir-");
		const restore = stubSkillEnv(home, agentDir);

		try {
			const admission: SkillAdmissionContext = {
				trusted: true,
				piResourceTrusted: true,
				acknowledged: [],
				disabled: [],
				disabledGroups: [],
				overrides: {},
			};
			const hasLate = async () => {
				const { resources } = await resourcesFor(project, true, () => admission);
				return (resources.skills ?? []).some((skill) => skill.name === "late-widget");
			};

			expect(await hasLate()).toBe(false);

			writeSkill(join(home, ".claude", "skills"), "late-widget", "appeared after start");
			expect(await hasLate()).toBe(true);
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a late-appearing untrusted project alias behind the trust gate on rebuild", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-skill-latetrust-");
		const restore = stubSkillEnv(home, agentDir);

		try {
			const admission: SkillAdmissionContext = {
				trusted: false,
				piResourceTrusted: false,
				acknowledged: [],
				disabled: [],
				disabledGroups: [],
				overrides: {},
			};
			const hasLate = async () => {
				const { resources } = await resourcesFor(project, true, () => admission);
				return (resources.skills ?? []).some((skill) => skill.name === "repo-late");
			};
			expect(await hasLate()).toBe(false);

			writeSkill(join(project, ".claude", "skills"), "repo-late", "committed, appeared late");
			expect(await hasLate()).toBe(false);
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("project prompt files under trust", () => {
	it("keeps a project's SYSTEM.md and rules out of an untrusted chat and in a trusted one", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-project-prompt-");
		mkdirSync(join(project, ".omp", "rules"), { recursive: true });
		writeFileSync(join(project, ".omp", "SYSTEM.md"), "PROJECT_SYSTEM_OVERRIDE\n");
		writeFileSync(
			join(project, ".omp", "rules", "repo-rule.md"),
			"---\ndescription: repo rule\nalwaysApply: true\n---\nPROJECT_RULE_BODY\n",
		);
		const restore = stubSkillEnv(home, agentDir);
		const prompt = async (projectTrusted: boolean) => {
			const resolved = await resourcesFor(project, projectTrusted, () => ({
				...ctx(false),
				piResourceTrusted: projectTrusted,
			}));
			const ruleNames = (resolved.resources.rules ?? []).map((rule) => rule.name);
			const text = await withSession(project, agentDir, resolved, (session) =>
				session.systemPrompt.join("\n"),
			);
			return { ruleNames, text };
		};
		try {
			const untrusted = await prompt(false);
			expect(untrusted.text).not.toContain("PROJECT_SYSTEM_OVERRIDE");
			expect(untrusted.ruleNames).not.toContain("repo-rule");
			expect(untrusted.text).not.toContain("PROJECT_RULE_BODY");

			writeFileSync(join(agentDir, "SYSTEM.md"), "USER_SYSTEM_OVERRIDE\n");
			expect((await prompt(false)).text).toContain("USER_SYSTEM_OVERRIDE");

			const trusted = await prompt(true);
			expect(trusted.text).toContain("PROJECT_SYSTEM_OVERRIDE");
			expect(trusted.text).toContain("PROJECT_RULE_BODY");
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("registry extensions", () => {
	async function withVisualize<T>(
		project: string,
		agentDir: string,
		run: (session: AgentSession) => Promise<T>,
	): Promise<T> {
		return withSession(project, agentDir, await resourcesFor(project, true, () => ctx(true)), run);
	}

	it("loads visualize as a registry extension that owns its tool, with the strict mermaid validator", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-registry-");
		const restore = stubSkillEnv(home, agentDir);
		try {
			await withVisualize(project, agentDir, async (session) => {
				expect(session.extensionRunner?.getRegisteredTool("visualize")).toBeDefined();
				expect(registryToolOwner("visualize")).toBe("visualize");
				const execute = (params: Record<string, unknown>) => {
					const tool = session.getToolByName("visualize");
					if (!tool) throw new Error("visualize tool is missing");
					return tool.execute("call", params);
				};
				await expect(
					execute({ type: "diagram", mermaid: "flowchart LR\n A --> B" }),
				).resolves.toMatchObject({ details: { type: "diagram" } });
				await expect(execute({ type: "diagram", mermaid: "flowchart LR\n A -->" })).rejects.toThrow(
					/invalid Mermaid syntax in `mermaid`[\s\S]*Parse error/,
				);
			});
		} finally {
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("omits a disabled extension from a new chat and re-decides on the next build", async () => {
		const { root, project, home, agentDir } = scratch("thinkrail-registry-off-");
		const restore = stubSkillEnv(home, agentDir);
		let disabled = new Set(["visualize"]);
		setDisabledExtensionsResolver(() => disabled);
		const hasVisualize = (session: AgentSession) =>
			session.extensionRunner?.getRegisteredTool("visualize") !== undefined;
		try {
			const off = await resourcesFor(project, true, () => ctx(true));
			disabled = new Set();
			expect(
				await withSession(project, agentDir, off, async (session) => hasVisualize(session)),
			).toBe(false);
			expect(await withVisualize(project, agentDir, async (session) => hasVisualize(session))).toBe(
				true,
			);

			disabled = new Set(["visualize", "retired-extension"]);
			expect(await withVisualize(project, agentDir, async (session) => hasVisualize(session))).toBe(
				false,
			);
		} finally {
			setDisabledExtensionsResolver(() => new Set());
			restore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a throwing resolver as nothing disabled", () => {
		setDisabledExtensionsResolver(() => {
			throw new Error("settings unavailable");
		});
		try {
			expect([...disabledExtensions()]).toEqual([]);
		} finally {
			setDisabledExtensionsResolver(() => new Set());
		}
	});

	it("keeps the curated child set and appends registry children", () => {
		const children = childExtensionFactories();
		expect(children).toHaveLength(1 + registryInlineExtensions("childExtensions").length);
		expect(children[0]).toBe(specGraphExtension);
		expect(children.slice(1)).toEqual(registryInlineExtensions("childExtensions"));
	});

	it("guards every child's images from the base set, not the opt-in curated set", () => {
		expect(childBaseExtensionFactories()).toEqual([oversizedImageGuard]);
		expect(childExtensionFactories()).not.toContain(oversizedImageGuard);
	});
});
