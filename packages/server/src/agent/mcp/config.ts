import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type MCPAuthConfig,
	type MCPHttpServerConfig,
	type MCPServerConfig,
	type MCPSseServerConfig,
	type MCPStdioServerConfig,
	validateServerConfig,
	validateServerName,
} from "@oh-my-pi/pi-coding-agent/mcp";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import type { McpExposure, McpProjectOverride, McpToolGrant, Project } from "@thinkrail/contracts";

const MCP_EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;
const TRANSPORTS = ["stdio", "http", "sse"] as const;
const AUTH_TYPES = ["oauth", "apikey"] as const;
const AUTH_STRINGS = ["credentialId", "tokenUrl", "clientId", "clientSecret", "resource"] as const;
const OAUTH_STRINGS = [
	"clientId",
	"clientSecret",
	"scope",
	"redirectUri",
	"callbackPath",
	"prompt",
] as const;

export type McpConfigScope = "global" | "project";

export interface McpHostFields {
	exposure?: McpExposure;
	toolExposure?: Record<string, McpExposure>;
	description?: string;
}

export type HostMcpServerConfig = MCPServerConfig & McpHostFields;

export interface HostMcpServerEntry {
	name: string;
	config: HostMcpServerConfig;
	source: string;
	scope: McpConfigScope;
	override?: string;
}

export function globalMcpConfigPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

export function projectMcpConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

export function mcpNamespace(server: string): string {
	const sanitized = server
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `mcp__${sanitized || "server"}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isOverrideEntry(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	for (const key of OAUTH_STRINGS) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			return `oauth.${key} must be a string`;
		}
	}
	const port = value.callbackPort;
	if (
		port !== undefined &&
		(typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
	) {
		return "oauth.callbackPort must be a port number";
	}
	return undefined;
}

function validateAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !oneOf(AUTH_TYPES, value.type)) {
		return 'auth.type must be "oauth" or "apikey"';
	}
	for (const key of AUTH_STRINGS) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			return `auth.${key} must be a string`;
		}
	}
	return undefined;
}

function validateHostFields(name: string, value: Record<string, unknown>): string | undefined {
	const { exposure, toolExposure, description } = value;
	const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ");
	if (exposure !== undefined && !oneOf(MCP_EXPOSURES, exposure)) {
		return `server "${name}": exposure must be one of ${exposures}`;
	}
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure))
			return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, entry] of Object.entries(toolExposure)) {
			if (!oneOf(MCP_EXPOSURES, entry))
				return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
		}
	}
	if (description !== undefined && typeof description !== "string") {
		return `server "${name}": description must be a string`;
	}
	return undefined;
}

function validateShared(name: string, value: Record<string, unknown>): string | undefined {
	const { type, enabled, timeout, instructions, requestIdFormat } = value;
	if (type !== undefined && !oneOf(TRANSPORTS, type)) {
		return `server "${name}": type must be "stdio", "http" or "sse"`;
	}
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return `server "${name}": enabled must be a boolean`;
	}
	if (
		timeout !== undefined &&
		(typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
	) {
		return `server "${name}": timeout must be a non-negative number of milliseconds`;
	}
	if (instructions !== undefined && typeof instructions !== "boolean") {
		return `server "${name}": instructions must be a boolean`;
	}
	if (requestIdFormat !== undefined && !oneOf(["string", "number"], requestIdFormat)) {
		return `server "${name}": requestIdFormat must be "string" or "number"`;
	}
	return validateHostFields(name, value);
}

function sharedFields(
	value: Record<string, unknown>,
): Omit<MCPStdioServerConfig, "command" | "type"> & McpHostFields {
	const { enabled, timeout, instructions, requestIdFormat, auth, oauth } = value;
	const { exposure, toolExposure, description } = value;
	return {
		...(typeof enabled === "boolean" ? { enabled } : {}),
		...(typeof timeout === "number" ? { timeout } : {}),
		...(typeof instructions === "boolean" ? { instructions } : {}),
		...(requestIdFormat === "string" || requestIdFormat === "number" ? { requestIdFormat } : {}),
		...(isRecord(auth) && oneOf(AUTH_TYPES, auth.type) ? { auth: authOf(auth, auth.type) } : {}),
		...(isRecord(oauth) ? { oauth: oauthOf(oauth) } : {}),
		...(oneOf(MCP_EXPOSURES, exposure) ? { exposure } : {}),
		...(isRecord(toolExposure) ? { toolExposure: exposureMap(toolExposure) } : {}),
		...(typeof description === "string" ? { description } : {}),
	};
}

function stringFields<K extends string>(
	value: Record<string, unknown>,
	keys: readonly K[],
): Partial<Record<K, string>> {
	const result: Partial<Record<K, string>> = {};
	for (const key of keys) {
		const entry = value[key];
		if (typeof entry === "string") result[key] = entry;
	}
	return result;
}

function authOf(value: Record<string, unknown>, type: MCPAuthConfig["type"]): MCPAuthConfig {
	return { type, ...stringFields(value, AUTH_STRINGS) };
}

function oauthOf(value: Record<string, unknown>): NonNullable<MCPServerConfig["oauth"]> {
	return {
		...stringFields(value, OAUTH_STRINGS),
		...(typeof value.callbackPort === "number" ? { callbackPort: value.callbackPort } : {}),
	};
}

function exposureMap(value: Record<string, unknown>): Record<string, McpExposure> {
	const result: Record<string, McpExposure> = {};
	for (const [tool, entry] of Object.entries(value)) {
		if (oneOf(MCP_EXPOSURES, entry)) result[tool] = entry;
	}
	return result;
}

function urlConfig(name: string, value: Record<string, unknown>): HostMcpServerConfig | string {
	const { url, headers, type } = value;
	if (typeof url !== "string" || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
		return `server "${name}": url must be an http or https URL`;
	}
	if (headers !== undefined && !isStringRecord(headers)) {
		return `server "${name}": headers must map names to strings`;
	}
	const oauthError = validateOAuth(value.oauth);
	if (oauthError) return `server "${name}": ${oauthError}`;
	const authError = validateAuth(value.auth);
	if (authError) return `server "${name}": ${authError}`;
	const common = { ...sharedFields(value), url, ...(headers === undefined ? {} : { headers }) };
	if (type === "sse") {
		const sse: MCPSseServerConfig & McpHostFields = { ...common, type: "sse" };
		return sse;
	}
	const http: MCPHttpServerConfig & McpHostFields = { ...common, type: "http" };
	return http;
}

function stdioConfig(name: string, value: Record<string, unknown>): HostMcpServerConfig | string {
	const { command, args, env, cwd } = value;
	if (typeof command !== "string" || command.length === 0) {
		return `server "${name}": command must be a non-empty string`;
	}
	if (args !== undefined && !isStringArray(args)) {
		return `server "${name}": args must be an array of strings`;
	}
	if (env !== undefined && !isStringRecord(env)) {
		return `server "${name}": env must map names to strings`;
	}
	if (cwd !== undefined && typeof cwd !== "string") {
		return `server "${name}": cwd must be a string`;
	}
	const authError = validateAuth(value.auth);
	if (authError) return `server "${name}": ${authError}`;
	const oauthError = validateOAuth(value.oauth);
	if (oauthError) return `server "${name}": ${oauthError}`;
	const stdio: MCPStdioServerConfig & McpHostFields = {
		...sharedFields(value),
		type: "stdio",
		command,
		...(args === undefined ? {} : { args }),
		...(env === undefined ? {} : { env }),
		...(cwd === undefined ? {} : { cwd }),
	};
	return stdio;
}

export function validateMcpServerConfig(name: string, raw: unknown): HostMcpServerConfig | string {
	const nameError = validateServerName(name);
	if (nameError) return `invalid server name "${name}" (${nameError})`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const sharedError = validateShared(name, raw);
	if (sharedError) return sharedError;
	const { type, url, command } = raw;
	const kind =
		type === "http" || type === "sse"
			? "url"
			: type === "stdio"
				? "stdio"
				: command !== undefined
					? "stdio"
					: url !== undefined
						? "url"
						: undefined;
	if (!kind) return `server "${name}" needs either "command" (stdio) or "url" (http)`;
	if (command !== undefined && url !== undefined) {
		return `server "${name}": set either "command" (stdio) or "url" (http/sse), not both`;
	}
	const config = kind === "url" ? urlConfig(name, raw) : stdioConfig(name, raw);
	if (typeof config === "string") return config;
	const errors = validateServerConfig(name, config);
	return errors.length > 0 ? errors.join("; ") : config;
}

export function ompServerConfig(config: HostMcpServerConfig): MCPServerConfig {
	const {
		exposure: _exposure,
		toolExposure: _toolExposure,
		description: _description,
		...rest
	} = config;
	return rest;
}

export interface McpConfigFileEntry {
	name: string;
	raw: unknown;
	path: string;
	scope: McpConfigScope;
	override: boolean;
}

export interface LoadedMcpFiles {
	servers: HostMcpServerEntry[];
	errors: string[];
	projectConfig?: string;
	entries: McpConfigFileEntry[];
	fileErrors: { path: string; message: string }[];
	disabledServers: string[];
	enabledServers: string[];
}

interface LoadState {
	servers: Map<string, HostMcpServerEntry>;
	errors: string[];
	entries: McpConfigFileEntry[];
	fileErrors: LoadedMcpFiles["fileErrors"];
	disabledServers: string[];
	enabledServers: string[];
	admitProjectEntry?: (entry: McpConfigFileEntry) => boolean;
}

function readServerLists(
	parsed: Record<string, unknown>,
	state: LoadState,
	fileError: (message: string) => void,
): void {
	for (const key of ["disabledServers", "enabledServers"] as const) {
		const list = parsed[key];
		if (list === undefined) continue;
		if (!isStringArray(list)) fileError(`${key} must be an array of server names`);
		else state[key] = list;
	}
}

function readConfigFile(path: string, scope: McpConfigScope, state: LoadState): void {
	const { servers, errors } = state;
	const fileError = (message: string) => {
		errors.push(`${path}: ${message}`);
		state.fileErrors.push({ path, message });
	};
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
	} catch (error) {
		fileError(error instanceof Error ? error.message : String(error));
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		fileError('expected an object with an "mcpServers" object');
		return;
	}
	if (scope === "global") readServerLists(parsed, state, fileError);
	const mcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
	for (const [name, value] of Object.entries(mcpServers)) {
		const entry: McpConfigFileEntry = {
			name,
			raw: value,
			path,
			scope,
			override: scope === "project" && isRecord(value) && isOverrideEntry(value),
		};
		state.entries.push(entry);
		if (scope === "project" && isRecord(value) && state.admitProjectEntry?.(entry) === false) {
			continue;
		}
		if (scope === "project" && isRecord(value) && isOverrideEntry(value)) {
			const base = servers.get(name);
			const extra = Object.keys(value).filter(
				(key) => !(OVERRIDE_KEYS as readonly string[]).includes(key),
			);
			if (!base) {
				errors.push(
					`${path}: server "${name}" needs "command" or "url", or a global server to override`,
				);
			} else if (extra.length > 0) {
				errors.push(
					`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`,
				);
			} else {
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				if (typeof config === "string") errors.push(`${path}: ${config}`);
				else servers.set(name, { ...base, config, override: path });
			}
			continue;
		}
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		const clash = [...servers.keys()].find(
			(other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
		);
		if (clash) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (scope === "project" && config.auth) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		servers.set(name, { name, config, source: path, scope });
	}
}

export function loadMcpConfigFiles(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	admitProjectEntry?: (entry: McpConfigFileEntry) => boolean;
}): LoadedMcpFiles {
	const state: LoadState = {
		servers: new Map(),
		errors: [],
		entries: [],
		fileErrors: [],
		disabledServers: [],
		enabledServers: [],
		...(options.admitProjectEntry ? { admitProjectEntry: options.admitProjectEntry } : {}),
	};
	readConfigFile(globalMcpConfigPath(options.agentDir), "global", state);
	const projectConfig = options.projectTrusted ? projectMcpConfigPath(options.cwd) : undefined;
	if (projectConfig) readConfigFile(projectConfig, "project", state);
	const disabled = new Set(state.disabledServers);
	const forced = new Set(state.enabledServers);
	const servers = [...state.servers.values()].map((server) => {
		if (disabled.has(server.name)) {
			return { ...server, config: { ...server.config, enabled: false } };
		}
		if (server.config.enabled === false && forced.has(server.name)) {
			return { ...server, config: { ...server.config, enabled: true } };
		}
		return server;
	});
	return {
		servers,
		errors: state.errors,
		...(projectConfig ? { projectConfig } : {}),
		entries: state.entries,
		fileErrors: state.fileErrors,
		disabledServers: state.disabledServers,
		enabledServers: state.enabledServers,
	};
}

function canonicalJson(value: unknown, preserveOrder = false): string {
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value);
		if (!preserveOrder) keys.sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], key === "toolExposure")}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function fingerprintMcpEntry(name: string, raw: unknown): string {
	return createHash("sha256")
		.update(`${JSON.stringify(name)}:${canonicalJson(raw)}`)
		.digest("hex");
}

export function mcpTargetOf(config: MCPServerConfig): string {
	const target =
		config.type === "http" || config.type === "sse"
			? { url: config.url }
			: { command: config.command, args: config.args ?? [] };
	return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

export function mcpToolLabel(server: string, tool: string): string {
	const prefix = `${mcpNamespace(server)}_`;
	return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

export function grantedMcpTools(
	policy: McpProjectPolicy,
	server: string,
	config: MCPServerConfig,
): readonly string[] {
	const grant = policy.toolGrants[server];
	return grant && grant.target === mcpTargetOf(config) ? grant.tools : [];
}

export type EffectiveMcpExposure = Exclude<McpExposure, "codemode">;

export const effectiveExposure = (exposure: McpExposure | undefined): EffectiveMcpExposure =>
	exposure === undefined || exposure === "codemode" ? "deferred" : exposure;

export function normalizeExposureForHost(config: HostMcpServerConfig): HostMcpServerConfig {
	const normalized: HostMcpServerConfig = {
		...config,
		exposure: effectiveExposure(config.exposure),
	};
	if (config.toolExposure) {
		normalized.toolExposure = Object.fromEntries(
			Object.entries(config.toolExposure).map(([tool, exposure]) => [
				tool,
				effectiveExposure(exposure),
			]),
		);
	}
	return normalized;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function toolExposureOf(config: McpHostFields, tool: string): EffectiveMcpExposure {
	const map = config.toolExposure ?? {};
	const exact = Object.hasOwn(map, tool) ? map[tool] : undefined;
	if (exact !== undefined) return effectiveExposure(exact);
	for (const [pattern, exposure] of Object.entries(map)) {
		if (pattern.includes("*") && globToRegExp(pattern).test(tool))
			return effectiveExposure(exposure);
	}
	return effectiveExposure(config.exposure);
}

export interface McpProjectPolicy {
	approvals: Readonly<Record<string, string>>;
	overrides: Readonly<Record<string, McpProjectOverride>>;
	toolGrants: Readonly<Record<string, McpToolGrant>>;
}

const ownEntries = <T>(record: Record<string, T> | undefined): Record<string, T> =>
	Object.assign(Object.create(null) as Record<string, T>, record);

export function mcpPolicyOf(
	project: Pick<Project, "mcpApprovals" | "mcpOverrides" | "mcpToolGrants"> | undefined,
): McpProjectPolicy {
	return {
		approvals: ownEntries(project?.mcpApprovals),
		overrides: ownEntries(project?.mcpOverrides),
		toolGrants: ownEntries(project?.mcpToolGrants),
	};
}

export function loadHostMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	policy: McpProjectPolicy;
	disabledInChat?: ReadonlySet<string>;
}): LoadedMcpFiles {
	const { policy, disabledInChat } = options;
	const loaded = loadMcpConfigFiles({
		agentDir: options.agentDir,
		cwd: options.cwd,
		projectTrusted: options.projectTrusted,
		admitProjectEntry: (entry) =>
			policy.approvals[entry.name] === fingerprintMcpEntry(entry.name, entry.raw),
	});
	const servers = loaded.servers.map((server) => {
		const override = server.scope === "global" ? policy.overrides[server.name] : undefined;
		const config: HostMcpServerConfig = { ...server.config };
		if (override?.enabled !== undefined) config.enabled = override.enabled;
		if (override?.exposure !== undefined) config.exposure = override.exposure;
		if (disabledInChat?.has(server.name)) config.enabled = false;
		return { ...server, config: normalizeExposureForHost(config) };
	});
	return { ...loaded, servers };
}
