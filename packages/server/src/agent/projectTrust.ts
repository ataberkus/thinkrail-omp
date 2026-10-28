import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ProjectResourceKind, ProjectTrustSummary } from "@thinkrail/contracts";
import { discoverAgentDefinitions } from "pi-subagents";
import { listProjectAliasSkillNames } from "./extensions";
import { loadMcpConfigFiles } from "./mcp";

const PROJECT_CONFIG_DIR = ".omp";

const PI_DIR_RESOURCES: ReadonlyArray<[ProjectResourceKind, string]> = [
	["extensions", "extensions"],
	["extensions", "hooks"],
	["extensions", "tools"],
	["settings", "settings.json"],
	["settings", "config.yml"],
	["skills", "skills"],
	["prompts", "prompts"],
	["systemPrompt", "SYSTEM.md"],
	["systemPrompt", "SYSTEM_TEMPLATE.md"],
	["systemPrompt", "RULES.md"],
	["systemPrompt", "rules"],
];

function canonical(path: string): string {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
}

function hasAncestorProjectSkills(cwd: string): boolean {
	const home = canonical(process.env.HOME || homedir());
	for (let dir = canonical(cwd); ; dir = dirname(dir)) {
		const skills = [join(dir, ".agents", "skills"), join(dir, PROJECT_CONFIG_DIR, "skills")];
		if (dir !== home && skills.some((candidate) => existsSync(candidate))) return true;
		if (dirname(dir) === dir) return false;
	}
}

function piResourceKinds(cwd: string): ProjectResourceKind[] {
	const piDir = join(canonical(cwd), PROJECT_CONFIG_DIR);
	const kinds = new Set<ProjectResourceKind>();
	for (const [kind, entry] of PI_DIR_RESOURCES) if (existsSync(join(piDir, entry))) kinds.add(kind);
	if (hasAncestorProjectSkills(cwd)) kinds.add("skills");
	const definitions = discoverAgentDefinitions({
		cwd,
		agentDir: getAgentDir(),
		includeProject: true,
	});
	if (definitions.some((definition) => definition.source === "project")) kinds.add("subagents");
	return [...kinds];
}

export async function projectTrustSummary(cwd: string): Promise<ProjectTrustSummary> {
	const mcpServers = loadMcpConfigFiles({
		agentDir: getAgentDir(),
		cwd,
		projectTrusted: true,
	}).entries.filter((entry) => entry.scope === "project").length;
	return {
		aliasSkills: await listProjectAliasSkillNames(cwd),
		piResources: piResourceKinds(cwd),
		mcpServers,
	};
}
