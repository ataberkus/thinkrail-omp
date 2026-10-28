import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { type IsolatedAgentDir, isolateAgentDir } from "pi-faux";
import { loadMcpConfigFiles } from "./mcp";
import {
	convertPiSessionText,
	isPiSessionText,
	migratePiAgentData,
	PiSessionFormatError,
	upgradePiSessionFile,
} from "./piMigration";

const FIXTURE = join(import.meta.dir, "fixtures", "pi-1.4.0-session.jsonl");
const PI_TEXT = readFileSync(FIXTURE, "utf8");
const PI_CWD = "/workspace/pi-project";

const root = mkdtempSync(join(tmpdir(), "thinkrail-pi-migration-"));
let agentDir: IsolatedAgentDir | undefined;
let scope = "";

beforeEach(() => {
	scope = mkdtempSync(join(root, "case-"));
	agentDir = isolateAgentDir(join(scope, "omp-agent"));
});

afterEach(() => agentDir?.restore());
afterAll(() => rmSync(root, { recursive: true, force: true }));

function records(text: string): Record<string, unknown>[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function ompSessionFile(name = basename(FIXTURE)): string {
	const dir = SessionManager.getDefaultSessionDir(PI_CWD);
	mkdirSync(dir, { recursive: true });
	return join(dir, name);
}

describe("a transcript pi 1.4.0 saved", () => {
	test("is recognised by the entries only pi writes", () => {
		expect(isPiSessionText(PI_TEXT)).toBe(true);
		expect(isPiSessionText(convertPiSessionText(PI_TEXT, FIXTURE))).toBe(false);
	});

	test("converts to omp's entry vocabulary without dropping the title, usage or edits", () => {
		const converted = records(convertPiSessionText(PI_TEXT, FIXTURE));
		expect(converted[0]).toMatchObject({
			type: "session",
			cwd: PI_CWD,
			title: "Listing the project",
			titleSource: "user",
		});
		expect(converted.map((entry) => entry.type)).toEqual([
			"session",
			"model_change",
			"thinking_level_change",
			"message",
			"message",
			"message",
			"message",
			"title_change",
			"model_usage",
			"model_usage",
		]);
		expect(converted.find((entry) => entry.type === "model_change")).toMatchObject({
			model: "anthropic/claude-sonnet-4-5",
		});
		expect(converted.filter((entry) => entry.type === "model_usage")).toMatchObject([
			{ purpose: "title", provider: "anthropic", model: "claude-haiku-4-5" },
			{ purpose: "subagent:child-session-1", model: "claude-sonnet-4-5" },
		]);
		const ids = new Set(converted.map((entry) => entry.id));
		for (const entry of converted.slice(1)) {
			if (entry.parentId !== null) expect(ids.has(entry.parentId)).toBe(true);
		}
	});

	test("opens in omp with its history, title, model and thinking level once upgraded in place", async () => {
		const file = ompSessionFile();
		writeFileSync(file, PI_TEXT);
		expect(await upgradePiSessionFile(file)).toBe(true);
		expect(readFileSync(`${file}.pi-1.x`, "utf8")).toBe(PI_TEXT);

		const manager = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
		try {
			expect(manager.getSessionName()).toBe("Listing the project");
			const context = manager.buildSessionContext();
			expect(context.models.default).toBe("anthropic/claude-sonnet-4-5");
			expect(context.thinkingLevel).toBe("high");
			expect(context.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(JSON.stringify(context.messages[2])).toContain("README.md\\nsrc");
			expect(JSON.stringify(context.messages[2])).not.toContain("secret.env");
		} finally {
			await manager.close();
		}
		const listed = await SessionManager.list(PI_CWD);
		expect(listed.map((info) => [info.id, info.title])).toEqual([
			[String(records(PI_TEXT)[0]?.id), "Listing the project"],
		]);
		expect(await upgradePiSessionFile(file)).toBe(false);
	});

	test("that cannot be converted fails explicitly and is left untouched", async () => {
		const broken = `${PI_TEXT.split("\n").slice(1).join("\n")}`;
		const file = ompSessionFile("broken.jsonl");
		writeFileSync(file, broken);
		await expect(upgradePiSessionFile(file)).rejects.toBeInstanceOf(PiSessionFormatError);
		expect(readFileSync(file, "utf8")).toBe(broken);
		expect(existsSync(`${file}.pi-1.x`)).toBe(false);
	});
});

describe("migratePiAgentData", () => {
	function piInstall(): string {
		const piDir = join(scope, "pi-agent");
		const bucket = join(piDir, "sessions", "--workspace-pi-project--");
		mkdirSync(bucket, { recursive: true });
		writeFileSync(join(bucket, basename(FIXTURE)), PI_TEXT);
		writeFileSync(join(bucket, "unreadable.jsonl"), "{not json\n{}\n");
		writeFileSync(
			join(piDir, "auth.json"),
			JSON.stringify({
				anthropic: { type: "api_key", key: "sk-pi" },
				openai: { type: "api_key", key: "sk-pi-openai" },
			}),
		);
		return piDir;
	}

	test("copies pi's chats and logins into omp once and never touches pi's files", async () => {
		const sourceDir = piInstall();
		const before = readdirSync(join(sourceDir, "sessions", "--workspace-pi-project--")).sort();
		const authStorage = await AuthStorage.create(":memory:");
		await authStorage.credentials.set("openai", { type: "api_key", key: "sk-omp" });

		const report = await migratePiAgentData(authStorage, { sourceDir });
		expect(report?.sessions).toMatchObject({ migrated: 1, skipped: 0 });
		expect(report?.sessions.failed).toHaveLength(1);
		expect(report?.credentials).toEqual({
			imported: ["anthropic"],
			kept: ["openai"],
			failed: [],
			signInAgain: [],
		});
		expect(authStorage.credentials.get("anthropic")).toMatchObject({ key: "sk-pi" });
		expect(authStorage.credentials.get("openai")).toMatchObject({ key: "sk-omp" });

		const migrated = join(SessionManager.getDefaultSessionDir(PI_CWD), basename(FIXTURE));
		expect(isPiSessionText(readFileSync(migrated, "utf8"))).toBe(false);
		expect(readdirSync(join(sourceDir, "sessions", "--workspace-pi-project--")).sort()).toEqual(
			before,
		);
		expect(
			readFileSync(
				join(sourceDir, "sessions", "--workspace-pi-project--", basename(FIXTURE)),
				"utf8",
			),
		).toBe(PI_TEXT);

		expect(await migratePiAgentData(authStorage, { sourceDir })).toBeNull();
	});

	test("a pi sign-in omp has no flow for is left for the user to redo; one omp knows is imported", async () => {
		const sourceDir = piInstall();
		const oauth = (access: string) => ({
			type: "oauth",
			access,
			refresh: `${access}-refresh`,
			expires: Date.now() + 86_400_000,
		});
		writeFileSync(
			join(sourceDir, "auth.json"),
			JSON.stringify({ openai: oauth("chatgpt"), "github-copilot": oauth("copilot") }),
		);
		const authStorage = await AuthStorage.create(":memory:");
		const report = await migratePiAgentData(authStorage, { sourceDir });
		expect(report?.credentials).toEqual({
			imported: ["github-copilot"],
			kept: [],
			failed: [],
			signInAgain: ["openai"],
		});
		expect(authStorage.credentials.has("openai")).toBe(false);
		expect(authStorage.credentials.get("github-copilot")).toMatchObject({ access: "copilot" });
	});

	test("imports pi's MCP servers into omp's mcp.json once, converted to omp's schema", async () => {
		const sourceDir = piInstall();
		const piMcp = JSON.stringify({
			mcpServers: {
				docs: {
					url: "https://docs.example/mcp",
					type: "streamable-http",
					timeout: 30,
					oauth: { clientId: "abc", callbackUrl: "http://127.0.0.1:8765/callback" },
					auth: { provider: "anthropic" },
					exposure: "codemode-deferred",
					toolExposure: { "get_*": "direct", "*": "codemode-deferred" },
					description: "Docs",
				},
				fs: { command: "npx", args: ["-y", "server"], env: { TOKEN: `\${TOKEN}` } },
				odd: null,
			},
			autoEnableCodemode: false,
		});
		writeFileSync(join(sourceDir, "mcp.json"), `\uFEFF${piMcp}`);
		const authStorage = await AuthStorage.create(":memory:");
		const report = await migratePiAgentData(authStorage, { sourceDir });
		expect(report?.mcpServers).toEqual({
			imported: ["docs", "fs", "odd"],
			kept: false,
			failed: [],
		});
		const target = join(scope, "omp-agent", "mcp.json");
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
			mcpServers: {
				docs: {
					url: "https://docs.example/mcp",
					type: "http",
					timeout: 30_000,
					oauth: { clientId: "abc", redirectUri: "http://127.0.0.1:8765/callback" },
					exposure: "codemode",
					toolExposure: { "get_*": "direct", "*": "codemode" },
					description: "Docs",
				},
				fs: { command: "npx", args: ["-y", "server"], env: { TOKEN: `\${TOKEN}` } },
				odd: null,
			},
		});
		expect(readFileSync(join(sourceDir, "mcp.json"), "utf8")).toBe(`\uFEFF${piMcp}`);
		const loaded = loadMcpConfigFiles({
			agentDir: join(scope, "omp-agent"),
			cwd: scope,
			projectTrusted: false,
		});
		expect(loaded.servers.map((server) => server.name)).toEqual(["docs", "fs"]);
	});

	test("never overwrites an omp mcp.json that already exists", async () => {
		const sourceDir = piInstall();
		writeFileSync(
			join(sourceDir, "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { url: "https://pi.example/mcp" } } }),
		);
		const target = join(scope, "omp-agent", "mcp.json");
		mkdirSync(join(scope, "omp-agent"), { recursive: true });
		const omp = JSON.stringify({ mcpServers: { mine: { url: "https://omp.example/mcp" } } });
		writeFileSync(target, omp);
		const report = await migratePiAgentData(await AuthStorage.create(":memory:"), { sourceDir });
		expect(report?.mcpServers).toEqual({ imported: [], kept: true, failed: [] });
		expect(readFileSync(target, "utf8")).toBe(omp);
	});

	test("does nothing without a pi installation", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		expect(await migratePiAgentData(authStorage, { sourceDir: join(scope, "absent") })).toBeNull();
	});
});
