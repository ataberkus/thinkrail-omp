/// <reference path="../ompPrompts.d.ts" />
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CreateAgentSessionOptions,
	discoverPromptTemplates,
	discoverSessionExtensionPaths,
	type ExtensionFactory,
	getAgentDir,
	loadSkills,
	loadSkillsFromDir,
	type PromptTemplate,
	type Settings,
	type Skill,
} from "@oh-my-pi/pi-coding-agent";
import {
	reset as forgetCapabilityReads,
	loadCapability,
} from "@oh-my-pi/pi-coding-agent/capability";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import {
	type SystemPrompt,
	systemPromptCapability,
} from "@oh-my-pi/pi-coding-agent/capability/system-prompt";
import {
	discoverCustomToolPaths,
	type ToolPathWithSource,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import bundledSystemPromptTemplate from "@oh-my-pi/pi-coding-agent/prompts/system/system-prompt" with {
	type: "text",
};
import type { SkillCatalogEntry, SlashCommandInfo } from "@thinkrail/contracts";
import specGraphExtension, { SPEC_BLOCK } from "pi-spec-graph";
import { WORKFLOW_BLOCK } from "pi-thinkrail-workflow";
import { TODO_BLOCK } from "pi-todos";
import {
	type ExtensionSessionServices,
	registryInlineExtensions,
	resolveExtensionSkillRoots,
	serverExtensions,
} from "../extensions";
import { type BundledTrashHelpers, setBundledTrashHelpers } from "../trash";
import { oversizedImageGuard } from "./imageGuard";
import { loadHostSettings } from "./piSettings";
import { requestReviewExtension } from "./requestReviewTool";
import { reviewToolExtension } from "./reviewTool";
import { decideSkill, type SkillAdmissionContext } from "./skillAdmission";
import {
	type CompatibilitySkillSource,
	candidateCompatibilitySkillRoots,
	discoverCompatibilitySkillSources,
} from "./skillSources";
import { setTitleExtension } from "./titleTool";

export type BundledExtensionFactory = ExtensionFactory;

export interface BundledExtensions {
	factories: BundledExtensionFactory[];
	skillsDir: string;
	trashHelpers: BundledTrashHelpers;
}

export const HOST_BUILTIN_TOOL_NAMES: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"glob",
	"find",
	"ast_grep",
	"ast_edit",
	"web_search",
];

export const HOST_RULE_BLOCKS: readonly string[] = [SPEC_BLOCK, WORKFLOW_BLOCK, TODO_BLOCK];

export function withHostRules(base: string[]): string[] {
	return [...base, ...HOST_RULE_BLOCKS.filter((block) => !base.includes(block))];
}

let bundled: BundledExtensions | undefined;

export async function registerBundledRuntime(extensions: BundledExtensions): Promise<void> {
	bundled = extensions;
	setBundledTrashHelpers(extensions.trashHelpers);
}

let devPaths: { extensionPaths: string[]; skillPaths: string[] } | undefined;
function resolveDevPaths(): { extensionPaths: string[]; skillPaths: string[] } {
	if (devPaths) return devPaths;
	const require = createRequire(import.meta.url);
	const specGraphPath = require.resolve("pi-spec-graph/index.ts");
	const workflowPath = require.resolve("pi-thinkrail-workflow/index.ts");
	const todosPath = require.resolve("pi-todos/index.ts");
	devPaths = {
		extensionPaths: [specGraphPath, workflowPath, todosPath],
		skillPaths: [
			join(dirname(specGraphPath), "skills"),
			join(dirname(workflowPath), "skills"),
			join(dirname(todosPath), "skills"),
			fileURLToPath(new URL("../../skills", import.meta.url)),
			...serverExtensions.flatMap(resolveExtensionSkillRoots),
		],
	};
	return devPaths;
}

function bundledSkillPaths(): string[] {
	return bundled ? [bundled.skillsDir] : resolveDevPaths().skillPaths;
}

function isUnderPath(path: string, root: string): boolean {
	const normalizedPath = resolve(path);
	const normalizedRoot = resolve(root);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function skillGroup(
	filePath: string,
	sources: CompatibilitySkillSource[],
	bundledPaths: string[],
	level: string | undefined,
): { group: string; isPlugin: boolean } {
	const source = sources.find((candidate) => isUnderPath(filePath, candidate.path));
	if (source?.plugin) return { group: source.plugin, isPlugin: true };
	if (source?.scope === "project") return { group: "project", isPlugin: false };
	if (source?.scope === "user") return { group: "personal", isPlugin: false };
	if (bundledPaths.some((path) => isUnderPath(filePath, path))) {
		return { group: "bundled", isPlugin: false };
	}
	if (level === "project") return { group: "project", isPlugin: false };
	return { group: "pi", isPlugin: false };
}

const OMP_SKILL_PROVIDERS = new Set(["native", "agents", "custom", "omp-managed"]);

function configuredSkillDirectories(settings: Settings): string[] {
	const directories: string[] = [];
	for (const layer of [settings.getProjectSettings(), settings.getGlobalSettings()]) {
		const skills: unknown = layer.skills;
		if (typeof skills !== "object" || skills === null) continue;
		const configured: unknown = Reflect.get(skills, "customDirectories");
		if (!Array.isArray(configured)) continue;
		for (const dir of configured) if (typeof dir === "string" && dir) directories.push(dir);
	}
	return directories;
}

async function candidateSkills(
	cwd: string,
	projectTrusted: boolean,
	settings?: Settings,
): Promise<Skill[]> {
	const hostSettings = settings ?? (await loadHostSettings(cwd, projectTrusted)).settings;
	const native = await loadSkills({
		cwd,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enableCodexUser: false,
		enablePiProject: projectTrusted,
		enableAgentsProject: projectTrusted,
		customDirectories: configuredSkillDirectories(hostSettings),
	});
	const compatibility = candidateCompatibilitySkillRoots(cwd);
	const extraRoots = [
		...bundledSkillPaths().map((dir) => ({ dir, source: "bundled:user" })),
		...compatibility
			.filter((root) => root.scope === "user")
			.map((root) => ({ dir: root.path, source: `${root.provider}:user` })),
		...compatibility
			.filter((root) => root.scope === "project")
			.map((root) => ({ dir: root.path, source: `${root.provider}:project` })),
	];
	const extra = await Promise.all(extraRoots.map((root) => loadSkillsFromDir(root)));
	const ompSkills = native.skills.filter((skill) =>
		OMP_SKILL_PROVIDERS.has(skill._source?.provider ?? ""),
	);
	const seen = new Set<string>();
	const skills: Skill[] = [];
	for (const skill of [...ompSkills, ...extra.flatMap((result) => result.skills)]) {
		if (seen.has(skill.name)) continue;
		seen.add(skill.name);
		skills.push(skill);
	}
	return skills;
}

function admittedSkills(
	cwd: string,
	skills: readonly Skill[],
	ctx: SkillAdmissionContext,
): Skill[] {
	const sources = discoverCompatibilitySkillSources(cwd);
	const projectAliasPaths = sources.filter((s) => s.scope === "project").map((s) => s.path);
	const bundledPaths = bundledSkillPaths();
	return skills.filter((skill) => {
		const isProjectAlias = projectAliasPaths.some((path) => isUnderPath(skill.filePath, path));
		const { group, isPlugin } = skillGroup(
			skill.filePath,
			sources,
			bundledPaths,
			skill._source?.level,
		);
		return decideSkill({ name: skill.name, isProjectAlias, group, isPlugin }, ctx) === "load";
	});
}

export function toSkillCommands(skills: readonly Skill[]): SlashCommandInfo[] {
	return skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill" as const,
		sourceInfo: skillSourceInfo(skill),
	}));
}

function skillSourceInfo(skill: Skill): SlashCommandInfo["sourceInfo"] {
	const level = skill._source?.level;
	return {
		path: skill.filePath,
		source: skill._source?.provider ?? skill.source,
		scope: level === "project" ? "project" : "user",
		origin: "top-level",
		baseDir: skill.baseDir,
	};
}

let disabledExtensionsResolver: () => ReadonlySet<string> = () => new Set();
export function setDisabledExtensionsResolver(resolver: () => ReadonlySet<string>): void {
	disabledExtensionsResolver = resolver;
}

export function disabledExtensions(): ReadonlySet<string> {
	try {
		return disabledExtensionsResolver();
	} catch {
		return new Set();
	}
}

const isExtensionDisabled = (name: string): boolean => disabledExtensions().has(name);

export function childBaseExtensionFactories(): ExtensionFactory[] {
	return [oversizedImageGuard];
}

export function childExtensionFactories(): ExtensionFactory[] {
	return [specGraphExtension, ...registryInlineExtensions("childExtensions", isExtensionDisabled)];
}

function projectScoped(path: string, cwd: string): boolean {
	return isUnderPath(path, cwd) && !isUnderPath(path, getAgentDir());
}

async function sessionExtensionPaths(
	cwd: string,
	settings: Settings,
	projectTrusted: boolean,
	excludedExtensionPaths: readonly string[],
): Promise<string[]> {
	const excluded = new Set(excludedExtensionPaths.map((path) => resolve(path)));
	const discovered = await discoverSessionExtensionPaths({}, cwd, settings);
	const kept = discovered.filter(
		(path) => !excluded.has(resolve(path)) && (projectTrusted || !projectScoped(path, cwd)),
	);
	return [...(bundled ? [] : resolveDevPaths().extensionPaths), ...kept];
}

export function isProjectPromptTemplate(template: PromptTemplate): boolean {
	return template.source.startsWith("(project");
}

export function promptTemplateSourceInfo(template: PromptTemplate): SlashCommandInfo["sourceInfo"] {
	return {
		path: `prompt:${template.name}`,
		source: template.source,
		scope: isProjectPromptTemplate(template) ? "project" : "user",
		origin: "top-level",
	};
}

async function sessionPromptTemplates(
	cwd: string,
	projectTrusted: boolean,
): Promise<PromptTemplate[]> {
	const templates = await discoverPromptTemplates(cwd, getAgentDir());
	return projectTrusted
		? templates
		: templates.filter((template) => !isProjectPromptTemplate(template));
}

export type SessionResourceOptions = Pick<
	CreateAgentSessionOptions,
	| "extensions"
	| "preloadedExtensionPaths"
	| "disableExtensionDiscovery"
	| "preloadedCustomToolPaths"
	| "skills"
	| "promptTemplates"
	| "slashCommands"
	| "toolNames"
	| "enableLsp"
	| "enableIrc"
	| "skipPythonPreflight"
	| "systemPrompt"
	| "rules"
	| "customSystemPrompt"
	| "systemPromptTemplate"
>;

export interface SessionResourceInput {
	cwd: string;
	settings: Settings;
	projectTrusted: boolean;
	getAdmission: () => SkillAdmissionContext;
	excludedExtensionPaths?: readonly string[];
	extraFactories?: ExtensionFactory[];
	session?: ExtensionSessionServices;
	onRegistryLoaded?: (name: string) => void;
}

async function sessionCustomToolPaths(
	cwd: string,
	projectTrusted: boolean,
): Promise<ToolPathWithSource[]> {
	const paths = await discoverCustomToolPaths([], cwd, getAgentDir());
	return projectTrusted ? paths : paths.filter((entry) => entry.source?.level !== "project");
}

async function untrustedPromptResources(
	cwd: string,
): Promise<Pick<SessionResourceOptions, "rules" | "customSystemPrompt" | "systemPromptTemplate">> {
	const [rules, prompt] = await Promise.all([
		loadCapability<Rule>(ruleCapability.id, { cwd, agentDir: getAgentDir() }),
		untrustedSystemPrompt(cwd),
	]);
	return { rules: rules.items.filter((rule) => rule._source.level !== "project"), ...prompt };
}

export type SystemPromptOverride = Pick<
	SessionResourceOptions,
	"customSystemPrompt" | "systemPromptTemplate"
>;

async function untrustedSystemPrompt(cwd: string): Promise<SystemPromptOverride> {
	const prompts = await loadCapability<SystemPrompt>(systemPromptCapability.id, { cwd });
	if (!prompts.items.some((prompt) => prompt.level === "project")) return {};
	const user = prompts.items.filter((prompt) => prompt.level === "user");
	const text = user.find((prompt) => (prompt.kind ?? "text") === "text");
	if (text) return { customSystemPrompt: text.content };
	const template = user.find((prompt) => prompt.kind === "template" && prompt.content.trim());
	return { systemPromptTemplate: template?.content ?? bundledSystemPromptTemplate };
}

export function childSystemPrompt(cwd: string): Promise<SystemPromptOverride> {
	forgetCapabilityReads();
	return untrustedSystemPrompt(cwd);
}

export async function buildSessionResources(
	input: SessionResourceInput,
): Promise<SessionResourceOptions> {
	const { cwd, settings, projectTrusted } = input;
	forgetCapabilityReads();
	const disabledAtLoad = disabledExtensions();
	const isDisabledAtLoad = (name: string): boolean => disabledAtLoad.has(name);
	const sharedFactories: ExtensionFactory[] = [
		...registryInlineExtensions(
			"extensions",
			isDisabledAtLoad,
			serverExtensions,
			input.session,
			input.onRegistryLoaded,
		),
		reviewToolExtension,
		requestReviewExtension,
		setTitleExtension,
		oversizedImageGuard,
		...(input.extraFactories ?? []),
	];
	const [extensionPaths, customToolPaths, skills, promptTemplates, promptResources] =
		await Promise.all([
			sessionExtensionPaths(cwd, settings, projectTrusted, input.excludedExtensionPaths ?? []),
			sessionCustomToolPaths(cwd, projectTrusted),
			candidateSkills(cwd, projectTrusted, settings),
			sessionPromptTemplates(cwd, projectTrusted),
			projectTrusted ? {} : untrustedPromptResources(cwd),
		]);
	return {
		extensions: bundled ? [...bundled.factories, ...sharedFactories] : sharedFactories,
		preloadedExtensionPaths: extensionPaths,
		disableExtensionDiscovery: true,
		preloadedCustomToolPaths: customToolPaths,
		skills: admittedSkills(cwd, skills, input.getAdmission()),
		promptTemplates,
		slashCommands: [],
		toolNames: [...HOST_BUILTIN_TOOL_NAMES],
		enableLsp: false,
		enableIrc: false,
		skipPythonPreflight: true,
		systemPrompt: withHostRules,
		...promptResources,
	};
}

function admissionCacheKey(cwd: string, ctx: SkillAdmissionContext): string {
	return JSON.stringify([
		cwd,
		ctx.trusted,
		ctx.piResourceTrusted,
		[...ctx.acknowledged].sort(),
		[...ctx.disabled].sort(),
		[...ctx.disabledGroups].sort(),
		Object.entries(ctx.overrides).sort(([a], [b]) => a.localeCompare(b)),
	]);
}

const SKILL_LIST_TTL_MS = 5_000;
const skillListCache = new Map<string, { at: number; value: SlashCommandInfo[] }>();

export async function listSkillCommands(
	cwd: string,
	admission: SkillAdmissionContext,
): Promise<SlashCommandInfo[]> {
	const cacheKey = admissionCacheKey(cwd, admission);
	const cached = skillListCache.get(cacheKey);
	if (cached && Date.now() - cached.at < SKILL_LIST_TTL_MS) return cached.value;
	forgetCapabilityReads();
	const skills = await candidateSkills(cwd, admission.piResourceTrusted);
	const value = toSkillCommands(admittedSkills(cwd, skills, admission));
	skillListCache.set(cacheKey, { at: Date.now(), value });
	return value;
}

export async function listProjectAliasSkillNames(cwd: string): Promise<string[]> {
	const projectPaths = discoverCompatibilitySkillSources(cwd)
		.filter((source) => source.scope === "project")
		.map((source) => source.path);
	if (projectPaths.length === 0) return [];
	const results = await Promise.all(
		projectPaths.map((dir) => loadSkillsFromDir({ dir, source: "project" })),
	);
	return results.flatMap((result) => result.skills.map((skill) => skill.name));
}

export async function listSkillCatalog(
	cwd: string,
	admission: SkillAdmissionContext,
): Promise<SkillCatalogEntry[]> {
	const discovered = discoverCompatibilitySkillSources(cwd);
	const bundledPaths = bundledSkillPaths();
	forgetCapabilityReads();
	const skills = await candidateSkills(cwd, admission.piResourceTrusted);
	return skills.map((skill) => {
		const source = discovered.find((candidate) => isUnderPath(skill.filePath, candidate.path));
		const gated = source?.scope === "project";
		const { group, isPlugin } = skillGroup(
			skill.filePath,
			discovered,
			bundledPaths,
			skill._source?.level,
		);
		return {
			name: skill.name,
			description: skill.description,
			sourceInfo: skillSourceInfo(skill),
			gated,
			group,
			...(source?.plugin ? { plugin: source.plugin } : {}),
			decision: decideSkill(
				{ name: skill.name, isProjectAlias: gated, group, isPlugin },
				admission,
			),
		};
	});
}
