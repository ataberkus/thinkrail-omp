import { analyzeAuthError } from "@oh-my-pi/pi-coding-agent/mcp";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { McpServerState, McpServerStatus, McpServerSummary } from "@thinkrail/contracts";
import { redactMcpText } from "./redact";

export type McpRuntimeState = Extract<
	McpServerState,
	"starting" | "connected" | "needs-sign-in" | "failed" | "disconnected" | "disabled"
>;

export interface McpRuntimeStatus {
	name: string;
	state: McpRuntimeState;
	toolCount?: number;
	detail?: string;
}

export interface McpRuntimeSource {
	connectionStatus(name: string): "connected" | "connecting" | "disconnected";
	toolCount(name: string): number;
}

export interface McpRuntimeServer {
	enabled?: boolean;
	type?: string;
	url?: string;
}

export class McpRuntimeTracker {
	readonly #failures = new Map<string, string>();
	readonly #seen = new Set<string>();

	observe(event: McpConnectionStatusEvent): void {
		if (event.type === "connecting") {
			for (const name of event.serverNames) this.#seen.add(name);
			return;
		}
		this.#seen.add(event.serverName);
		if (event.type === "failed") this.#failures.set(event.serverName, event.error);
		else if (event.type === "connected") this.#failures.delete(event.serverName);
	}

	fail(name: string, error: string): void {
		this.#seen.add(name);
		this.#failures.set(name, error);
	}

	statuses(
		servers: ReadonlyMap<string, McpRuntimeServer>,
		source: McpRuntimeSource | null,
	): McpRuntimeStatus[] {
		return [...servers].map(([name, config]): McpRuntimeStatus => {
			if (config.enabled === false) return { name, state: "disabled" };
			const connection = source?.connectionStatus(name) ?? "connecting";
			if (connection === "connected") {
				return { name, state: "connected", toolCount: source?.toolCount(name) ?? 0 };
			}
			const failure = this.#failures.get(name);
			if (connection === "connecting" || (failure === undefined && !this.#seen.has(name))) {
				return { name, state: "starting" };
			}
			if (failure === undefined) {
				return { name, state: "disconnected", detail: "Connection closed" };
			}
			const needsSignIn =
				(config.type === "http" || config.type === "sse") &&
				analyzeAuthError(new Error(failure), config.url).requiresAuth;
			return { name, state: needsSignIn ? "needs-sign-in" : "failed", detail: failure };
		});
	}
}

export interface ParsedMcpServerStatus {
	state: McpServerState;
	toolCount?: number;
	detail: string;
}

export interface ParsedMcpStatus {
	servers: Map<string, ParsedMcpServerStatus>;
	configErrors: string[];
}

export function reportMcpRuntime(
	statuses: readonly McpRuntimeStatus[],
	configErrors: readonly string[] = [],
): ParsedMcpStatus {
	return {
		servers: new Map(
			statuses.map((status) => [
				status.name,
				{
					state: status.state,
					...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
					detail: redactMcpText(status.detail ?? ""),
				},
			]),
		),
		configErrors: configErrors.map(redactMcpText),
	};
}

export function formatMcpRuntime(statuses: readonly McpRuntimeStatus[]): string {
	if (statuses.length === 0) return "No MCP servers configured.";
	return statuses
		.map((status) => {
			const tools = status.toolCount !== undefined ? `, ${status.toolCount} tools` : "";
			const detail = status.detail ? `\n    ${status.detail.split("\n").join("\n    ")}` : "";
			return `${status.name}: ${status.state}${tools}${detail}`;
		})
		.join("\n");
}

export function deriveMcpServerStatuses(options: {
	summaries: readonly McpServerSummary[];
	reported: ParsedMcpStatus | null;
	disabledInChat: ReadonlySet<string>;
	pendingReload?: ReadonlySet<string>;
	previous: readonly McpServerStatus[];
	now: number;
}): McpServerStatus[] {
	const { summaries, reported, disabledInChat, previous, now } = options;
	const before = new Map(previous.map((status) => [status.name, status]));
	const names = [
		...new Set([...summaries.map((summary) => summary.name), ...(reported?.servers.keys() ?? [])]),
	];
	return names.map((name): McpServerStatus => {
		const configured = summaries.filter((summary) => summary.name === name);
		const pending = configured.find(
			(summary) => summary.scope === "project" && summary.approval?.state !== "approved",
		);
		const invalid = configured.find((summary) => summary.configError);
		const parsed = reported?.servers.get(name);
		const stamp = (status: Omit<McpServerStatus, "name" | "updatedAt">): McpServerStatus => ({
			name,
			...status,
			updatedAt: now,
		});
		if (options.pendingReload?.has(name)) {
			return stamp({
				state: "pending-reload",
				...(parsed?.toolCount !== undefined ? { toolCount: parsed.toolCount } : {}),
				detail: "Applies when the chat is idle",
			});
		}
		if (parsed?.state === "disabled") {
			if (disabledInChat.has(name))
				return stamp({ state: "disabled-in-chat", detail: parsed.detail });
			if (configured.some((summary) => summary.projectOverride?.enabled === false)) {
				return stamp({ state: "disabled-in-project", detail: parsed.detail });
			}
			return stamp({ state: "disabled", detail: parsed.detail });
		}
		if (parsed) {
			return stamp({
				state: parsed.state,
				...(parsed.toolCount !== undefined ? { toolCount: parsed.toolCount } : {}),
				detail: parsed.detail,
			});
		}
		if (pending && !configured.some((summary) => summary.scope === "user")) {
			return stamp({ state: "pending-approval" });
		}
		if (invalid) return stamp({ state: "invalid-config", detail: invalid.configError ?? "" });
		if (reported === null) {
			const last = before.get(name);
			return last ? { ...last } : stamp({ state: "unknown" });
		}
		return stamp({ state: "unknown" });
	});
}
