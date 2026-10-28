import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { analyzeAuthError, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import {
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredentials,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import { reauthorizeMcpServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { type HostMcpServerConfig, ompServerConfig } from "./config";

export interface McpSignInPresentation {
	onAuthUrl(url: string, instructions: string | undefined): void;
	onPasteBack(signal: AbortSignal | undefined): Promise<string>;
	onProgress?(message: string): void;
}

const flowOwners = new Map<string, object>();

function flowOwnerFor(name: string): object {
	const existing = flowOwners.get(name);
	if (existing) return existing;
	const owner = {};
	flowOwners.set(name, owner);
	return owner;
}

export async function signInMcpServer(options: {
	name: string;
	config: HostMcpServerConfig;
	authStorage: AuthStorage;
	cwd: string;
	signal?: AbortSignal;
	presentation: McpSignInPresentation;
}): Promise<void> {
	const { name, presentation } = options;
	await reauthorizeMcpServer(
		name,
		{
			filePath: "",
			scope: "user",
			config: ompServerConfig(options.config),
			discovered: false,
			acpOwned: true,
		},
		{
			authStorage: options.authStorage,
			cwd: options.cwd,
			flowOwner: flowOwnerFor(name),
			...(options.signal ? { signal: options.signal } : {}),
			onAuth: (info) => presentation.onAuthUrl(info.url, info.instructions),
			onManualCodeInput: (signal) => presentation.onPasteBack(signal),
			...(presentation.onProgress
				? { onProgress: (message: string) => presentation.onProgress?.(message) }
				: {}),
		},
	);
}

export async function signOutMcpServer(
	config: HostMcpServerConfig,
	authStorage: AuthStorage,
): Promise<boolean> {
	const ids: (string | undefined)[] = [];
	if (config.auth?.type === "oauth") ids.push(config.auth.credentialId);
	if (config.type === "http" || config.type === "sse") {
		ids.push(...mcpOAuthCredentialIdsForServerUrl(config.url));
	}
	return removeManagedMcpOAuthCredentials(authStorage, ids);
}

export type McpConnectionTest =
	| { kind: "connected"; toolCount: number }
	| { kind: "needs-sign-in"; message: string }
	| { kind: "failed"; message: string };

export async function testMcpConnection(options: {
	name: string;
	config: HostMcpServerConfig;
	authStorage: AuthStorage;
	cwd: string;
}): Promise<McpConnectionTest> {
	const { name } = options;
	const config = expandEnvVarsDeep(ompServerConfig({ ...options.config, enabled: true }));
	const manager = new MCPManager(options.cwd);
	manager.setAuthStorage(options.authStorage);
	try {
		const result = await manager.connectServers({ [name]: config }, {}, undefined, 0);
		if (result.connectedServers.includes(name)) {
			const toolCount = manager.getTools().filter((tool) => tool.mcpServerName === name).length;
			return { kind: "connected", toolCount };
		}
		const message = result.errors.get(name) ?? "The server did not answer.";
		const url = config.type === "http" || config.type === "sse" ? config.url : undefined;
		return analyzeAuthError(new Error(message), url).requiresAuth
			? { kind: "needs-sign-in", message }
			: { kind: "failed", message };
	} finally {
		await manager.disconnectAll();
	}
}
