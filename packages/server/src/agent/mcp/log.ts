import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { McpServerLog } from "@thinkrail/contracts";
import { redactMcpText } from "./redact";

const MCP_LOG_TAIL_LINES = 200;
const MCP_LOG_READ_BYTES = 8 * 1024 * 1024;
const MCP_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const ENTRY_HEAD = /^\d{4}-\d\d-\d\dT[\d:.]+Z \[([A-Za-z0-9_.: -]+)\] /;
const CONTINUATION = "    ";

export function mcpLogPath(): string {
	return join(getAgentDir(), "mcp.log");
}

function formatData(data: unknown): string {
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data) ?? String(data);
	} catch {
		return String(data);
	}
}

export function formatMcpLogMessage(server: string, params: unknown, now = new Date()): string {
	const message: Record<string, unknown> = isLogRecord(params) ? params : { data: params };
	const level = typeof message.level === "string" ? message.level : "info";
	const logger = typeof message.logger === "string" && message.logger ? ` ${message.logger}:` : "";
	const text = formatData(message.data).replace(/\r?\n/g, `\n${CONTINUATION}`);
	return `${now.toISOString()} [${server}] ${level}${logger} ${text}\n`;
}

function isLogRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function appendMcpServerLog(server: string, params: unknown, path = mcpLogPath()): void {
	const line = formatMcpLogMessage(server, params);
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (sizeOf(path) > MCP_LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
		appendFileSync(path, line);
	} catch {}
}

export function mcpServerLogLines(
	text: string,
	name: string,
	limit = MCP_LOG_TAIL_LINES,
): string[] {
	const lines: string[] = [];
	let owner: string | undefined;
	for (const line of text.split("\n")) {
		const head = ENTRY_HEAD.exec(line);
		if (head) owner = head[1];
		else if (!line.startsWith(CONTINUATION)) owner = undefined;
		if (owner === name) lines.push(line);
	}
	return lines.slice(-limit);
}

async function openIfPresent(path: string): Promise<FileHandle | null> {
	try {
		return await open(path, "r");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

async function readTail(path: string): Promise<string> {
	const handle = await openIfPresent(path);
	if (!handle) return "";
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, MCP_LOG_READ_BYTES);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, size - length);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		return size > length ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		await handle.close();
	}
}

export async function readMcpServerLog(name: string): Promise<McpServerLog> {
	const path = mcpLogPath();
	const [rotated, current] = await Promise.all([readTail(`${path}.1`), readTail(path)]);
	const lines = mcpServerLogLines(`${rotated}\n${current}`, name);
	return { path, text: redactMcpText(lines.join("\n")) };
}
