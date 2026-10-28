import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type AuthCredential, type AuthStorage, getOAuthProviders } from "@oh-my-pi/pi-ai";
import { getAgentDir, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { logger } from "../log";
import { usagePurpose } from "./usagePurpose";

const log = logger("agent");

const MIGRATION_MARKER = "thinkrail-pi-migration.json";
const PI_CONTEXT_REMOVED = "thinkrail.pi-context-removed";
const PI_ONLY_ENTRY_TYPES = new Set(["session_info", "usage", "context_edit"]);

export function piAgentDir(): string {
	return process.env.THINKRAIL_PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export class PiSessionFormatError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PiSessionFormatError";
	}
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLines(text: string, source: string): JsonRecord[] {
	const records: JsonRecord[] = [];
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			if (index === lines.length - 1) continue;
			throw new PiSessionFormatError(`${source}: line ${index + 1} is not JSON`, { cause: error });
		}
		if (!isRecord(value))
			throw new PiSessionFormatError(`${source}: line ${index + 1} is not an object`);
		records.push(value);
	}
	const header = records[0];
	if (header?.type !== "session" || typeof header.id !== "string")
		throw new PiSessionFormatError(`${source}: the session header is missing`);
	return records;
}

export function isPiSessionText(text: string): boolean {
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(value)) continue;
		if (typeof value.type === "string" && PI_ONLY_ENTRY_TYPES.has(value.type)) return true;
		if (value.type === "model_change" && typeof value.modelId === "string") return true;
	}
	return false;
}

function replaceContent(entry: JsonRecord, replacement: unknown): JsonRecord {
	if (!isRecord(replacement)) return entry;
	const content = replacement.content;
	if (entry.type === "custom_message") return { ...entry, content };
	const message = entry.message;
	if (!isRecord(message)) return entry;
	const normalized =
		typeof content === "string" && (message.role === "assistant" || message.role === "toolResult")
			? [{ type: "text", text: content }]
			: content;
	return { ...entry, message: { ...message, content: normalized } };
}

export function convertPiSessionText(text: string, source: string): string {
	const records = parseLines(text, source);
	const edits = new Map<string, JsonRecord>();
	for (const record of records) {
		if (record.type === "context_edit" && typeof record.targetId === "string")
			edits.set(record.targetId, record);
	}
	const converted: JsonRecord[] = [];
	const remap = new Map<string, string | null>();
	const parentOf = (record: JsonRecord): string | null => {
		let parent = typeof record.parentId === "string" ? record.parentId : null;
		while (parent !== null && remap.has(parent)) parent = remap.get(parent) ?? null;
		return parent;
	};
	let title: string | undefined;
	for (const record of records) {
		if (record.type === "session_info" && typeof record.name === "string")
			title = record.name || undefined;
	}
	for (const record of records) {
		if (record.type === "session") {
			converted.push(title === undefined ? record : { ...record, title, titleSource: "user" });
			continue;
		}
		const id = typeof record.id === "string" ? record.id : undefined;
		const base = { ...record, parentId: parentOf(record) };
		let next: JsonRecord | undefined;
		switch (record.type) {
			case "context_edit":
				if (id) remap.set(id, base.parentId as string | null);
				next = undefined;
				break;
			case "session_info":
				next =
					typeof record.name === "string" && record.name
						? {
								type: "title_change",
								id,
								parentId: base.parentId,
								timestamp: record.timestamp,
								title: record.name,
								source: "user",
							}
						: {
								type: "custom",
								id,
								parentId: base.parentId,
								timestamp: record.timestamp,
								customType: "thinkrail.pi-session-info",
								data: record,
							};
				break;
			case "usage": {
				const kind = typeof record.kind === "string" ? record.kind : "usage";
				const note = typeof record.note === "string" ? record.note : undefined;
				next = {
					type: "model_usage",
					id,
					parentId: base.parentId,
					timestamp: record.timestamp,
					purpose: usagePurpose(kind, note),
					api: typeof record.api === "string" ? record.api : "",
					provider: record.provider,
					model: record.model,
					usage: record.usage,
					stopReason: "stop",
				};
				break;
			}
			case "model_change":
				next =
					typeof record.modelId === "string" && typeof record.provider === "string"
						? {
								type: "model_change",
								id,
								parentId: base.parentId,
								timestamp: record.timestamp,
								model: `${record.provider}/${record.modelId}`,
							}
						: base;
				break;
			default: {
				const edit = id ? edits.get(id) : undefined;
				if (!edit) {
					next = base;
					break;
				}
				next =
					edit.replacement === null
						? {
								type: "custom",
								id,
								parentId: base.parentId,
								timestamp: record.timestamp,
								customType: PI_CONTEXT_REMOVED,
								data: record,
							}
						: replaceContent(base, edit.replacement);
			}
		}
		if (!next) continue;
		const cleaned = Object.fromEntries(
			Object.entries(next).filter(([, value]) => value !== undefined),
		);
		converted.push(cleaned);
	}
	return `${converted.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export async function upgradePiSessionFile(path: string): Promise<boolean> {
	const text = await readFile(path, "utf8");
	if (!isPiSessionText(text)) return false;
	const converted = convertPiSessionText(text, path);
	const backup = `${path}.pi-1.x`;
	if (!existsSync(backup)) await copyFile(path, backup);
	const staged = `${path}.migrating`;
	await writeFile(staged, converted, { mode: 0o600 });
	await rename(staged, path);
	log.info(`converted pi chat ${path} to omp's format; the original is kept at ${backup}`);
	return true;
}

export interface PiMigrationReport {
	sessions: { migrated: number; skipped: number; failed: string[] };
	credentials: { imported: string[]; kept: string[]; failed: string[]; signInAgain: string[] };
	mcpServers: { imported: string[]; kept: boolean; failed: string[] };
}

const PI_OAUTH_RENAMES: Record<string, string> = { callbackUrl: "redirectUri" };

function ompMcpEntry(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const { type, timeout, auth: _auth, oauth, exposure, toolExposure, ...rest } = value;
	const codemode = (entry: unknown) => (entry === "codemode-deferred" ? "codemode" : entry);
	return {
		...rest,
		...(type === undefined ? {} : { type: type === "streamable-http" ? "http" : type }),
		...(typeof timeout === "number" ? { timeout: timeout * 1000 } : {}),
		...(isRecord(oauth)
			? {
					oauth: Object.fromEntries(
						Object.entries(oauth).map(([key, entry]) => [PI_OAUTH_RENAMES[key] ?? key, entry]),
					),
				}
			: {}),
		...(exposure === undefined ? {} : { exposure: codemode(exposure) }),
		...(isRecord(toolExposure)
			? {
					toolExposure: Object.fromEntries(
						Object.entries(toolExposure).map(([tool, entry]) => [tool, codemode(entry)]),
					),
				}
			: {}),
	};
}

async function migrateMcpConfig(
	sourceDir: string,
	targetAgentDir: string,
	report: PiMigrationReport,
): Promise<void> {
	const source = join(sourceDir, "mcp.json");
	const target = join(targetAgentDir, "mcp.json");
	if (!existsSync(source)) return;
	if (existsSync(target)) {
		report.mcpServers.kept = true;
		return;
	}
	try {
		const parsed: unknown = JSON.parse((await readFile(source, "utf8")).replace(/^\uFEFF/, ""));
		if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
			throw new Error('expected an object with an "mcpServers" object');
		}
		const servers = Object.fromEntries(
			Object.entries(parsed.mcpServers).map(([name, entry]) => [name, ompMcpEntry(entry)]),
		);
		await mkdir(targetAgentDir, { recursive: true });
		const staged = `${target}.migrating`;
		await writeFile(staged, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, {
			mode: 0o600,
		});
		await rename(staged, target);
		report.mcpServers.imported.push(...Object.keys(servers));
	} catch (error) {
		log.warn(`pi MCP servers at ${source} were not imported`, error);
		report.mcpServers.failed.push(source);
	}
}

function piCredential(value: unknown): AuthCredential | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "api_key" && typeof value.key === "string" && value.key)
		return { type: "api_key", key: value.key };
	if (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number"
	) {
		const { type: _type, ...rest } = value;
		return {
			...rest,
			type: "oauth",
			access: value.access,
			refresh: value.refresh,
			expires: value.expires,
		};
	}
	return undefined;
}

async function migrateCredentials(
	sourceDir: string,
	authStorage: AuthStorage,
	report: PiMigrationReport,
): Promise<void> {
	const authPath = join(sourceDir, "auth.json");
	if (!existsSync(authPath)) return;
	let stored: unknown;
	try {
		stored = JSON.parse(await readFile(authPath, "utf8"));
	} catch (error) {
		log.warn(`pi credentials at ${authPath} are unreadable and were not imported`, error);
		report.credentials.failed.push(authPath);
		return;
	}
	if (!isRecord(stored)) return;
	const signInIds = new Set(
		getOAuthProviders().map((provider) => provider.storeCredentialsAs ?? provider.id),
	);
	for (const [providerId, value] of Object.entries(stored)) {
		if (authStorage.credentials.has(providerId)) {
			report.credentials.kept.push(providerId);
			continue;
		}
		const credential = piCredential(value);
		if (!credential) continue;
		if (credential.type === "oauth" && !signInIds.has(providerId)) {
			log.info(`pi's ${providerId} sign-in has no omp equivalent; sign in again in ThinkRail`);
			report.credentials.signInAgain.push(providerId);
			continue;
		}
		try {
			await authStorage.credentials.set(providerId, credential);
			report.credentials.imported.push(providerId);
		} catch (error) {
			log.warn(`pi credential for ${providerId} could not be imported`, error);
			report.credentials.failed.push(providerId);
		}
	}
}

async function sessionFiles(sourceDir: string): Promise<string[]> {
	const root = join(sourceDir, "sessions");
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const bucket of await readdir(root, { withFileTypes: true })) {
		if (!bucket.isDirectory()) continue;
		for (const name of await readdir(join(root, bucket.name))) {
			if (name.endsWith(".jsonl")) files.push(join(root, bucket.name, name));
		}
	}
	return files;
}

function sessionCwd(text: string): string | undefined {
	const first = text.split(/\r?\n/).find((line) => line.trim());
	if (!first) return undefined;
	try {
		const header: unknown = JSON.parse(first);
		return isRecord(header) && typeof header.cwd === "string" && header.cwd
			? header.cwd
			: undefined;
	} catch {
		return undefined;
	}
}

async function migrateSessions(
	sourceDir: string,
	targetAgentDir: string,
	report: PiMigrationReport,
): Promise<void> {
	for (const file of await sessionFiles(sourceDir)) {
		try {
			const text = await readFile(file, "utf8");
			const cwd = sessionCwd(text);
			if (!cwd)
				throw new PiSessionFormatError(`${file}: the session header has no working directory`);
			const targetDir = SessionManager.getDefaultSessionDir(cwd, targetAgentDir);
			const target = join(targetDir, basename(file));
			if (existsSync(target)) {
				report.sessions.skipped++;
				continue;
			}
			const converted = convertPiSessionText(text, file);
			await mkdir(targetDir, { recursive: true });
			const staged = `${target}.migrating`;
			await writeFile(staged, converted, { mode: 0o600 });
			await rename(staged, target);
			report.sessions.migrated++;
		} catch (error) {
			log.warn(`pi chat ${file} was not migrated and stays only in pi's directory`, error);
			report.sessions.failed.push(file);
		}
	}
}

export async function migratePiAgentData(
	authStorage: AuthStorage,
	options: { sourceDir?: string; targetAgentDir?: string } = {},
): Promise<PiMigrationReport | null> {
	const sourceDir = options.sourceDir ?? piAgentDir();
	const targetAgentDir = options.targetAgentDir ?? getAgentDir();
	const marker = join(targetAgentDir, MIGRATION_MARKER);
	if (existsSync(marker) || !existsSync(sourceDir)) return null;
	const report: PiMigrationReport = {
		sessions: { migrated: 0, skipped: 0, failed: [] },
		credentials: { imported: [], kept: [], failed: [], signInAgain: [] },
		mcpServers: { imported: [], kept: false, failed: [] },
	};
	await migrateCredentials(sourceDir, authStorage, report);
	await migrateMcpConfig(sourceDir, targetAgentDir, report);
	await migrateSessions(sourceDir, targetAgentDir, report);
	await mkdir(targetAgentDir, { recursive: true });
	await writeFile(
		marker,
		`${JSON.stringify({ version: 1, sourceDir, migratedAt: new Date().toISOString(), report }, null, "\t")}\n`,
	);
	log.info(
		`imported pi data from ${sourceDir}: ${report.sessions.migrated} chat(s), ${report.credentials.imported.length} login(s), ${report.mcpServers.imported.length} MCP server(s)`,
	);
	return report;
}

export async function migratePiAgentDataOnBoot(
	authStorage: () => Promise<AuthStorage>,
): Promise<void> {
	try {
		await migratePiAgentData(await authStorage());
	} catch (error) {
		log.error("importing pi's chats and logins failed; pi's files are unchanged", error);
	}
}
