import {
	type AgentSession,
	type CreateAgentSessionOptions,
	type CustomTool,
	type CustomToolResult,
	type ExtensionCommandContext,
	type ExtensionFactory,
	getAgentDir,
	type RegisteredCommand,
} from "@oh-my-pi/pi-coding-agent";
import { signInMcpServer, signOutMcpServer } from "./auth";
import {
	grantedMcpTools,
	type HostMcpServerConfig,
	isRecord,
	loadHostMcpConfig,
	type McpProjectPolicy,
	mcpTargetOf,
	toolExposureOf,
} from "./config";
import { type DeliverMcpTools, McpEngineLoad } from "./engine";
import { mcpCallResultOf, summarizeMcpResult } from "./results";
import { acquireMcpSignInLock } from "./signInLock";
import { formatMcpRuntime, type McpRuntimeStatus } from "./status";

export const MCP_CONFIRM_DENY = "Deny";
export const MCP_CONFIRM_ONCE = "Allow once";
export const MCP_CONFIRM_CHAT = "Allow in this chat";
export const MCP_CONFIRM_ALWAYS = "Always allow";
const CONFIRM_OPTIONS = [MCP_CONFIRM_DENY, MCP_CONFIRM_ONCE, MCP_CONFIRM_CHAT];
const CONFIRM_OPTIONS_WITH_ALWAYS = [...CONFIRM_OPTIONS, MCP_CONFIRM_ALWAYS];
const ALWAYS_ALLOW_SCOPE =
	"Always allow trusts this tool in every chat of this project. Manage it in Settings › MCP servers.";
const PASTE_BACK_TITLE = "Paste the address the browser was sent to after signing in";

export interface McpSessionHost {
	extensions: ExtensionFactory[];
	disabledInChat: Set<string>;
	loaded(): ReadonlyMap<string, HostMcpServerConfig> | null;
	registered(): readonly McpRuntimeStatus[];
	sessionOptions(): Pick<CreateAgentSessionOptions, "enableMCP" | "mcpManager">;
	attach(session: AgentSession): void;
	shutdownEngine(): Promise<void>;
	reconnect(name: string): Promise<void>;
	startup(): Promise<void>;
}

export type AskForToolCall = (
	toolCallId: string,
	input: Record<string, unknown>,
	title: string,
	options: string[],
	signal: AbortSignal | undefined,
) => Promise<string | undefined>;

export type GrantMcpTool = (server: string, target: string, tool: string) => void;

export interface McpSessionHostOptions {
	cwd: string;
	policy: () => McpProjectPolicy;
	projectTrusted: () => boolean;
	onCommandSettled?: (sessionId: string) => void;
	askForToolCall: AskForToolCall;
	grantTool: GrantMcpTool;
}

function blockedResult(tool: CustomTool, reason: string): CustomToolResult {
	return {
		content: [{ type: "text", text: reason }],
		details: { serverName: tool.mcpServerName, mcpToolName: tool.mcpToolName, isError: true },
		isError: true,
	};
}

function withSummary(tool: CustomTool, result: CustomToolResult): CustomToolResult {
	const summary = summarizeMcpResult(
		tool.name,
		mcpCallResultOf(result.details),
		result.isError === true,
	);
	const {
		rawContent: _raw,
		structuredContent: _structured,
		...details
	} = isRecord(result.details) ? result.details : {};
	return {
		...result,
		details: {
			...details,
			server: tool.mcpServerName,
			tool: tool.mcpToolName,
			...(summary ? { thinkrail: summary } : {}),
		},
	};
}

function spilledArtifact(details: unknown): string | undefined {
	if (!isRecord(details) || typeof details.serverName !== "string") return undefined;
	const meta = details.meta;
	const truncation = isRecord(meta) ? meta.truncation : undefined;
	const id = isRecord(truncation) ? truncation.artifactId : undefined;
	return typeof id === "string" ? id : undefined;
}

function parseCommand(args: string): { action: string; name?: string; extra: string[] } {
	const [action = "", name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	return { action, ...(name !== undefined ? { name } : {}), extra };
}

export function createMcpSessionHost({
	cwd,
	policy,
	projectTrusted,
	onCommandSettled,
	askForToolCall,
	grantTool,
}: McpSessionHostOptions): McpSessionHost {
	const allowedInChat = new Set<string>();
	const disabledInChat = new Set<string>();
	let load: McpEngineLoad | null = null;
	let loaded: Map<string, HostMcpServerConfig> | null = null;
	let sessionId: string | undefined;
	let hasUI: () => boolean = () => false;
	const settle = () => {
		if (sessionId !== undefined) onCommandSettled?.(sessionId);
	};

	const confirm = async (
		tool: CustomTool,
		config: HostMcpServerConfig | undefined,
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
	): Promise<string | undefined> => {
		if (tool.mcpReadOnlyHint === true || allowedInChat.has(tool.name)) return undefined;
		const server = tool.mcpServerName;
		if (
			server !== undefined &&
			config &&
			grantedMcpTools(policy(), server, config).includes(tool.name)
		) {
			return undefined;
		}
		if (!hasUI()) return "This MCP call needs the user's confirmation, and no UI is attached.";
		const question = `Allow ${server ?? "mcp"}/${tool.mcpToolName ?? tool.name}? It may change data.`;
		const answer = await askForToolCall(
			toolCallId,
			isRecord(params) ? params : {},
			config ? `${question}\n${ALWAYS_ALLOW_SCOPE}` : question,
			config ? CONFIRM_OPTIONS_WITH_ALWAYS : CONFIRM_OPTIONS,
			signal,
		);
		if (answer === MCP_CONFIRM_ALWAYS && server !== undefined && config) {
			grantTool(server, mcpTargetOf(config), tool.name);
			return undefined;
		}
		if (answer === MCP_CONFIRM_ONCE) return undefined;
		if (answer === MCP_CONFIRM_CHAT) {
			allowedInChat.add(tool.name);
			return undefined;
		}
		if (answer === MCP_CONFIRM_DENY) return "The user denied this MCP call.";
		return signal?.aborted
			? "The MCP call was cancelled before the user confirmed it."
			: "The user did not confirm this MCP call: they dismissed it or replied in the chat instead.";
	};

	const hostTool = (tool: CustomTool, current: McpEngineLoad): CustomTool[] => {
		const server = tool.mcpServerName;
		const config = server === undefined ? undefined : current.servers.get(server)?.config;
		const exposure = config ? toolExposureOf(config, tool.mcpToolName ?? "") : "deferred";
		if (exposure === "hidden") return [];
		const execute: CustomTool["execute"] = async (toolCallId, params, onUpdate, ctx, signal) => {
			const blocked = await confirm(tool, config, toolCallId, params, signal);
			if (blocked !== undefined) return blockedResult(tool, blocked);
			return withSummary(tool, await tool.execute(toolCallId, params, onUpdate, ctx, signal));
		};
		return [
			new Proxy<CustomTool>(tool, {
				get: (target, key) =>
					key === "execute"
						? execute
						: key === "loadMode" && exposure === "direct"
							? "essential"
							: Reflect.get(target, key),
			}),
		];
	};

	const deliver: DeliverMcpTools = async (session, tools) => {
		const current = load;
		if (!current || current.closed) return;
		await session.refreshMCPTools(tools.flatMap((tool) => hostTool(tool, current)));
	};

	const configOf = (name: string): HostMcpServerConfig | undefined =>
		load?.servers.get(name)?.config;

	const login = async (name: string, ctx: ExtensionCommandContext): Promise<void> => {
		const config = configOf(name);
		const current = load;
		if (!config || !current) {
			ctx.ui.notify(`No MCP server named "${name}" is configured for this chat.`, "error");
			return;
		}
		const authStorage = ctx.modelRegistry.authStorage;
		const dismissed = new AbortController();
		await signInMcpServer({
			name,
			config,
			authStorage,
			cwd,
			signal: AbortSignal.any([current.signal, dismissed.signal]),
			presentation: {
				onAuthUrl: (url) =>
					ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url}`, "info"),
				onPasteBack: async (signal) => {
					const value = await ctx.ui.input(
						PASTE_BACK_TITLE,
						undefined,
						signal ? { signal } : undefined,
					);
					if (value) return value;
					dismissed.abort();
					throw new Error("Sign-in cancelled.");
				},
			},
		});
		await current.reconnect(name).catch(() => {});
		ctx.ui.notify(`Signed in to MCP server "${name}".`, "info");
	};

	const logout = async (name: string, ctx: ExtensionCommandContext): Promise<void> => {
		const config = configOf(name);
		const current = load;
		if (!config || !current) {
			ctx.ui.notify(`No MCP server named "${name}" is configured for this chat.`, "error");
			return;
		}
		const removed = await signOutMcpServer(config, ctx.modelRegistry.authStorage);
		await current.reconnect(name).catch(() => {});
		ctx.ui.notify(
			removed
				? `Signed out of MCP server "${name}".`
				: `No stored sign-in for MCP server "${name}".`,
			"info",
		);
	};

	const runSignIn = async (
		action: "login" | "logout",
		name: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const lock = acquireMcpSignInLock(name, "chat");
		if ("heldBy" in lock) {
			const where = lock.heldBy === "settings" ? "in Settings" : "in a chat";
			ctx.ui.notify(`A sign-in for "${name}" is already running ${where}.`, "warning");
			return;
		}
		try {
			if (action === "login") await login(name, ctx);
			else await logout(name, ctx);
		} finally {
			lock.release();
		}
	};

	const handler: RegisteredCommand["handler"] = async (args, ctx) => {
		const { action, name, extra } = parseCommand(args);
		if (action === "" || action === "list" || action === "status") {
			ctx.ui.notify(formatMcpRuntime(load?.statuses() ?? []), "info");
			return;
		}
		if (
			(action !== "login" && action !== "logout" && action !== "reconnect") ||
			name === undefined ||
			extra.length > 0
		) {
			ctx.ui.notify("Usage: /mcp [list] | /mcp login|logout|reconnect <server>", "warning");
			return;
		}
		try {
			if (action === "reconnect") {
				if (!load) throw new Error(`No MCP server named "${name}" is configured for this chat.`);
				await load.reconnect(name);
				ctx.ui.notify(`Reconnected to MCP server "${name}".`, "info");
			} else {
				await runSignIn(action, name, ctx);
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			settle();
		}
	};

	const commandExtension: ExtensionFactory = (pi) => {
		pi.registerCommand("mcp", {
			description: "MCP servers: status, login <server>, logout <server>, reconnect <server>",
			handler,
		});
		pi.on("tool_result", async (event, ctx) => {
			const artifact = spilledArtifact(event.details);
			if (artifact === undefined || !isRecord(event.details)) return undefined;
			const path = await ctx.sessionManager.getArtifactPath(artifact);
			return { details: { ...event.details, fullOutputPath: path ?? `artifact://${artifact}` } };
		});
	};

	return {
		extensions: [commandExtension],
		disabledInChat,
		loaded: () => loaded,
		registered: () => {
			if (load) return load.statuses();
			return [];
		},
		sessionOptions: () => {
			const previous = load;
			if (previous && !previous.closed) void previous.close();
			const config = loadHostMcpConfig({
				agentDir: getAgentDir(),
				cwd,
				projectTrusted: projectTrusted(),
				policy: policy(),
				disabledInChat,
			});
			loaded = new Map(config.servers.map((server) => [server.name, server.config]));
			const next = new McpEngineLoad(cwd, config.servers, settle);
			load = next;
			if (!config.servers.some((server) => server.config.enabled !== false)) {
				return { enableMCP: false };
			}
			return { enableMCP: true, mcpManager: next.manager };
		},
		attach: (session) => {
			sessionId = session.sessionId;
			const runner = session.extensionRunner;
			hasUI = () => runner?.hasUI() === true;
			load?.attach(session, deliver);
		},
		shutdownEngine: () => load?.close() ?? Promise.resolve(),
		startup: () => load?.startup() ?? Promise.resolve(),
		reconnect: async (name) => {
			if (!load) throw new Error(`No MCP server named "${name}" is configured for this chat.`);
			try {
				await load.reconnect(name);
			} finally {
				settle();
			}
		},
	};
}
