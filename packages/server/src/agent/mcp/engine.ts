import {
	type AgentSession,
	type CustomTool,
	MCP_DISCOVERY_TURN_WAIT_MS,
} from "@oh-my-pi/pi-coding-agent";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	type LoadMCPConfigsResult,
	MCPManager,
	type MCPServerConfig,
} from "@oh-my-pi/pi-coding-agent/mcp";
import { type HostMcpServerEntry, ompServerConfig } from "./config";
import { appendMcpServerLog } from "./log";
import { type McpRuntimeStatus, McpRuntimeTracker } from "./status";

export type DeliverMcpTools = (
	session: AgentSession,
	tools: readonly CustomTool[],
) => Promise<void>;

function sourceOf(entry: HostMcpServerEntry): SourceMeta {
	return {
		provider: "thinkrail",
		providerName: "ThinkRail",
		path: entry.override ?? entry.source,
		level: entry.scope === "global" ? "user" : "project",
	};
}

export class McpEngineLoad {
	readonly manager: MCPManager;
	readonly servers: ReadonlyMap<string, HostMcpServerEntry>;
	readonly #tracker = new McpRuntimeTracker();
	readonly #onStatus: () => void;
	readonly #unsubscribe: (() => void)[] = [];
	readonly #abort = new AbortController();
	#closed = false;
	#attached = false;
	#cleanup: Promise<void> | undefined;
	#discovery: Promise<void> | undefined;

	constructor(cwd: string, servers: readonly HostMcpServerEntry[], onStatus: () => void) {
		this.servers = new Map(servers.map((server) => [server.name, server]));
		this.#onStatus = onStatus;
		this.manager = new MCPManager(cwd, null, () => this.#loadConfigs());
	}

	get closed(): boolean {
		return this.#closed;
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	async #loadConfigs(): Promise<LoadMCPConfigsResult> {
		const configs: Record<string, MCPServerConfig> = {};
		const sources: Record<string, SourceMeta> = {};
		if (this.#closed) return { configs, sources, exaApiKeys: [] };
		for (const [name, entry] of this.servers) {
			if (entry.config.enabled === false) continue;
			configs[name] = expandEnvVarsDeep(ompServerConfig(entry.config));
			sources[name] = sourceOf(entry);
		}
		return { configs, sources, exaApiKeys: [] };
	}

	attach(session: AgentSession, deliver: DeliverMcpTools): void {
		if (this.#closed || this.#attached) return;
		if (![...this.servers.values()].some((entry) => entry.config.enabled !== false)) return;
		this.#attached = true;
		const { manager } = this;
		if (MCPManager.instance() === manager) MCPManager.setInstance(undefined);
		manager.setAuthStorage(session.modelRegistry.authStorage);
		const publish = async (tools: readonly CustomTool[]) => {
			if (this.#closed || session.isDisposed) return;
			await deliver(session, tools);
		};
		manager.setOnToolsChanged((tools) => publish(tools));
		this.#unsubscribe.push(
			manager.addConnectionStatusListener((event) => {
				this.#tracker.observe(event);
				this.#onStatus();
			}),
			manager.addToolsChangedListener(() => {
				void publish(manager.getTools()).catch(() => {});
				this.#onStatus();
			}),
			manager.addNotificationListener((server, method, params) => {
				if (method === "notifications/message") appendMcpServerLog(server, params);
			}),
		);
		this.#discovery = (async () => {
			try {
				const result = await manager.discoverAndConnect();
				if (this.#closed) return;
				for (const [name, error] of result.errors) this.#tracker.fail(name, error);
				await publish(result.tools);
				await manager.waitForStartup(MCP_DISCOVERY_TURN_WAIT_MS);
				await publish(manager.getTools());
			} catch {
			} finally {
				if (this.#closed) await manager.disconnectAll();
				this.#onStatus();
			}
		})();
		session.setPendingMCPDiscovery(this.#discovery);
	}

	startup(): Promise<void> {
		return this.#discovery ?? Promise.resolve();
	}

	statuses(): McpRuntimeStatus[] {
		const configs = new Map([...this.servers].map(([name, entry]) => [name, entry.config]));
		const { manager } = this;
		return this.#tracker.statuses(
			configs,
			this.#attached
				? {
						connectionStatus: (name) => manager.getConnectionStatus(name),
						toolCount: (name) =>
							manager.getTools().filter((tool) => tool.mcpServerName === name).length,
					}
				: null,
		);
	}

	async reconnect(name: string): Promise<void> {
		const entry = this.servers.get(name);
		if (!entry) throw new Error(`No MCP server named "${name}" is configured for this chat.`);
		if (entry.config.enabled === false) throw new Error(`MCP server "${name}" is disabled.`);
		if (this.#closed) throw new Error("The chat is closing.");
		try {
			const connection = await this.manager.reconnectServer(name, { manual: true });
			if (!connection) {
				const failure = this.statuses().find((status) => status.name === name)?.detail;
				throw new Error(failure ?? `Could not reconnect to MCP server "${name}".`);
			}
		} finally {
			this.#onStatus();
		}
	}

	close(): Promise<void> {
		this.#closed = true;
		this.#abort.abort();
		this.#cleanup ??= (async () => {
			for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
			await this.manager.disconnectAll();
			await this.#discovery;
		})();
		return this.#cleanup;
	}
}
