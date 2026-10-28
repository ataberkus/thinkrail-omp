import type { McpConfigFileError, McpExposure, McpServerSummary } from "@thinkrail/contracts";
import {
	effectiveExposure,
	fingerprintMcpEntry,
	grantedMcpTools,
	isRecord,
	type LoadedMcpFiles,
	loadHostMcpConfig,
	loadMcpConfigFiles,
	type McpConfigFileEntry,
	type McpProjectPolicy,
	mcpToolLabel,
	validateMcpServerConfig,
} from "./config";
import { maskMcpEndpoint, redactMcpText } from "./redact";

const EXPOSURES: readonly McpExposure[] = ["deferred", "direct", "hidden", "codemode"];

function configuredExposure(raw: Record<string, unknown>): McpExposure {
	const value = raw.exposure;
	return EXPOSURES.find((exposure) => exposure === value) ?? "deferred";
}

function usesOAuth(raw: Record<string, unknown>): boolean {
	return raw.auth === undefined || (isRecord(raw.auth) && raw.auth.type === "oauth");
}

function hasAuthorizationHeader(raw: Record<string, unknown>): boolean {
	return (
		isRecord(raw.headers) && Object.keys(raw.headers).some((key) => /^authorization$/i.test(key))
	);
}

function configErrorFor(entry: McpConfigFileEntry, errors: readonly string[]): string | undefined {
	if (!entry.override) {
		const validated = validateMcpServerConfig(entry.name, entry.raw);
		if (typeof validated === "string") return validated;
	}
	const prefix = `${entry.path}: server "${entry.name}"`;
	const listed = errors.find((error) => error.startsWith(prefix));
	return listed ? listed.slice(entry.path.length + 2) : undefined;
}

function approvalOf(
	name: string,
	fingerprint: string,
	policy: McpProjectPolicy,
): NonNullable<McpServerSummary["approval"]> {
	const approved = policy.approvals[name];
	return {
		state: approved === fingerprint ? "approved" : approved ? "changed" : "pending",
		fingerprint,
	};
}

export function summarizeMcpServers(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	policy: McpProjectPolicy;
}): McpServerSummary[] {
	const { policy } = options;
	const written: LoadedMcpFiles = loadMcpConfigFiles({
		agentDir: options.agentDir,
		cwd: options.cwd,
		projectTrusted: options.projectTrusted,
	});
	const effective = new Map(
		loadHostMcpConfig(options).servers.map((server) => [server.name, server]),
	);
	const globalNames = new Set(
		written.entries.filter((entry) => entry.scope === "global").map((entry) => entry.name),
	);
	const overrides = new Map(
		written.entries
			.filter((entry) => entry.scope === "project" && entry.override)
			.map((entry) => [entry.name, entry]),
	);
	const summaries: McpServerSummary[] = [];
	for (const entry of written.entries) {
		if (entry.override && globalNames.has(entry.name)) continue;
		const raw = isRecord(entry.raw) ? entry.raw : {};
		const live = effective.get(entry.name);
		const isEffective = live !== undefined && live.scope === entry.scope;
		const projectOverride = entry.scope === "global" ? policy.overrides[entry.name] : undefined;
		const exposure = configuredExposure(raw);
		const repoOverride = entry.scope === "global" ? overrides.get(entry.name) : undefined;
		const transport =
			raw.type === "http" ||
			raw.type === "sse" ||
			(raw.type === undefined && raw.command === undefined && raw.url !== undefined)
				? "http"
				: "stdio";
		const fingerprint = fingerprintMcpEntry(entry.name, entry.raw);
		const granted = isEffective ? grantedMcpTools(policy, entry.name, live.config) : [];
		const configError = [
			configErrorFor(entry, written.errors),
			repoOverride ? configErrorFor(repoOverride, written.errors) : undefined,
		]
			.filter(Boolean)
			.join("\n");
		summaries.push({
			name: entry.name,
			scope: entry.scope === "global" ? "user" : "project",
			source: entry.path,
			fingerprint,
			transport,
			endpoint: maskMcpEndpoint(raw),
			effective: isEffective,
			exposure,
			effectiveExposure: isEffective
				? effectiveExposure(live.config.exposure)
				: (projectOverride?.exposure ?? effectiveExposure(exposure)),
			enabled: isEffective ? live.config.enabled !== false : raw.enabled !== false,
			...(typeof raw.description === "string"
				? { description: redactMcpText(raw.description) }
				: {}),
			oauth: transport === "http" && !hasAuthorizationHeader(raw) && usesOAuth(raw),
			...(entry.scope === "project" && globalNames.has(entry.name) ? { replacesGlobal: true } : {}),
			...(projectOverride ? { projectOverride } : {}),
			...(entry.scope === "project"
				? { approval: approvalOf(entry.name, fingerprint, policy) }
				: repoOverride
					? {
							approval: approvalOf(
								entry.name,
								fingerprintMcpEntry(repoOverride.name, repoOverride.raw),
								policy,
							),
						}
					: {}),
			...(configError ? { configError: redactMcpText(configError) } : {}),
			...(granted.length > 0
				? {
						alwaysAllowed: granted.map((tool) => ({
							tool,
							label: mcpToolLabel(entry.name, tool),
						})),
					}
				: {}),
		});
	}
	return summaries;
}

export function summarizeMcpConfigErrors(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): McpConfigFileError[] {
	return loadMcpConfigFiles(options).fileErrors.map((error) => ({
		source: error.path,
		message: redactMcpText(error.message),
	}));
}
