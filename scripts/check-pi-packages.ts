#!/usr/bin/env bun
// Vanilla-parity gate for pi-extensions/*; the bar and its rationale live in pi-extensions/SPEC.md.
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { packPiPackage, publishablePiPackages, repoRoot } from "./pi-packages.ts";

interface ScriptedUi {
	mode: "tui" | "rpc";
	replies?: (string | number | null)[];
	keys?: string[];
}

interface ParityCase {
	tool: string;
	name: string;
	args: Record<string, unknown>;
	ui?: ScriptedUi;
	expectError?: string;
	expectText?: string[];
	expectTerminate?: boolean;
	expectRender?: { width?: number; contains?: string[] };
}

interface Expectation {
	tools: string[];
	skills: string[];
	cases: ParityCase[];
}

const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
	workspaces: { catalog: Record<string, string> };
};
const ompVersion = rootManifest.workspaces.catalog["@oh-my-pi/pi-coding-agent"];
if (!ompVersion) throw new Error("check-pi-packages: omp version missing from the root catalog");

const ASK_LIBRARY = {
	question: "Which library?",
	header: "Lib",
	options: [
		{ label: "date-fns", description: "small" },
		{ label: "luxon", description: "rich" },
	],
};
const ASK_TARGETS = {
	question: "Which targets?",
	header: "Targets",
	multiSelect: true,
	options: [
		{ label: "web", description: "browser" },
		{ label: "cli", description: "terminal" },
	],
};
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", space: " " };

const EXPECTATIONS: Record<string, Expectation> = {
	"@thinkrail/pi-ask-user-question": {
		tools: ["ask_user_question"],
		skills: [],
		cases: [
			{
				tool: "ask_user_question",
				name: "no-ui-reports-unavailable",
				args: { questions: [ASK_LIBRARY] },
				expectText: ["UI not available"],
			},
			{
				tool: "ask_user_question",
				name: "invalid-questionnaire-rejected",
				args: { questions: [] },
				ui: { mode: "rpc" },
				expectText: ["At least one question is required"],
			},
			{
				tool: "ask_user_question",
				name: "terminal-answer",
				args: { questions: [ASK_LIBRARY] },
				ui: { mode: "tui", keys: [KEY.down, KEY.enter] },
				expectText: ['"Which library?"="luxon"'],
				expectRender: { width: 80, contains: ["✓ Lib: luxon"] },
			},
			{
				tool: "ask_user_question",
				name: "terminal-multi-with-own-answer",
				args: { questions: [ASK_TARGETS] },
				ui: {
					mode: "tui",
					keys: [KEY.space, KEY.down, KEY.down, "t", "r", "a", "y", KEY.enter],
				},
				expectText: ['"Which targets?"="web"', 'user\'s own answer: "tray"'],
				expectRender: { width: 80, contains: ["✓ Targets: web, “tray”"] },
			},
			{
				tool: "ask_user_question",
				name: "terminal-skip",
				args: { questions: [ASK_LIBRARY] },
				ui: { mode: "tui", keys: [KEY.escape] },
				expectText: ["User declined to answer questions"],
				expectRender: { width: 80, contains: ["Skipped"] },
			},
			{
				tool: "ask_user_question",
				name: "terminal-chat-ends-the-turn",
				args: { questions: [ASK_LIBRARY, ASK_TARGETS] },
				ui: { mode: "tui", keys: [KEY.up, KEY.enter] },
				expectText: ["discuss these questions in chat"],
				expectTerminate: true,
				expectRender: { width: 80, contains: ["Continuing in chat"] },
			},
			{
				tool: "ask_user_question",
				name: "dialog-answer",
				args: { questions: [ASK_LIBRARY] },
				ui: { mode: "rpc", replies: [1] },
				expectText: ['"Which library?"="luxon"'],
			},
			{
				tool: "ask_user_question",
				name: "dialog-own-answer",
				args: { questions: [ASK_LIBRARY] },
				ui: { mode: "rpc", replies: [2, "dayjs"] },
				expectText: ['"Which library?"="dayjs"'],
			},
			{
				tool: "ask_user_question",
				name: "dialog-multi-numbers",
				args: { questions: [ASK_TARGETS] },
				ui: { mode: "rpc", replies: ["1,2"] },
				expectText: ['"Which targets?"="web, cli"'],
			},
			{
				tool: "ask_user_question",
				name: "dialog-dismiss-declines",
				args: { questions: [ASK_LIBRARY] },
				ui: { mode: "rpc", replies: [null] },
				expectText: ["User declined to answer questions"],
			},
		],
	},
	"@thinkrail/pi-visualize": {
		tools: ["visualize"],
		skills: [],
		cases: [
			{
				tool: "visualize",
				name: "flowchart",
				args: {
					type: "diagram",
					title: "Flow",
					mermaid: "flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]",
				},
				expectText: ["```mermaid", "A[Start] --> B{Ok?}"],
				expectRender: { width: 100, contains: ["┌", "Start", "Done"] },
			},
			{
				tool: "visualize",
				name: "sequence",
				args: {
					type: "diagram",
					mermaid: "sequenceDiagram\n  participant A as Alice\n  A->>B: hi\n  B-->>A: hello",
				},
				expectRender: { width: 100, contains: ["Alice", "hi", "hello"] },
			},
			{
				tool: "visualize",
				name: "unsupported-family-passes-through",
				args: {
					type: "diagram",
					mermaid: "gantt\n  title X\n  section S\n  task :a1, 2024-01-01, 3d",
				},
				expectText: ["gantt"],
				expectRender: { width: 100, contains: ["gantt"] },
			},
			{
				tool: "visualize",
				name: "back-and-forth-labels",
				args: {
					type: "diagram",
					mermaid: "flowchart LR\n  U[User] -->|request| A[App]\n  A -->|response| U",
				},
				expectRender: { width: 100, contains: ["request", "response"] },
			},
			{
				tool: "visualize",
				name: "bad-direction-rejected",
				args: { type: "diagram", mermaid: "flowchart XX\n  A --> B" },
				expectError: "invalid Mermaid syntax in `mermaid`: unknown flowchart direction",
			},
			{
				tool: "visualize",
				name: "dropped-fragment-rejected",
				args: {
					type: "comparison",
					options: [{ name: "Broken", mermaid: "flowchart LR\n  A --> B\n  C -->" }],
				},
				expectError:
					"invalid Mermaid syntax in `options\\[0\\]\\.mermaid`: part of the diagram could not be read",
			},
			{
				tool: "visualize",
				name: "comparison",
				args: {
					type: "comparison",
					options: [
						{ name: "A", pros: ["fast"], recommended: true },
						{ name: "B", cons: ["slow"] },
					],
				},
				expectText: ["✅ Recommended", "- fast", "- slow"],
				expectRender: { width: 100, contains: ["A", "fast", "slow"] },
			},
		],
	},
};

const LEGACY_ENGINE_IMPORTS = [
	/["'`]@(?:earendil-works|mariozechner)\/pi-[\w-]+(?:\/[^"'`]*)?["'`]/,
	/["'`](?:@sinclair\/typebox|typebox)["'`]/,
	/["'`]@oh-my-pi\/pi-coding-agent\/extensibility\/[^"'`]*legacy-pi-[^"'`]*["'`]/,
];

interface PackedPackage {
	name: string;
	version: string;
	tarball: string;
	manifest: Record<string, unknown>;
	bytes: Uint8Array;
}

function fail(message: string): never {
	console.error(`check-pi-packages: FAIL — ${message}`);
	process.exit(1);
}

async function run(
	command: string,
	args: string[],
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	const proc = Bun.spawn([command, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [status, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (status !== 0)
		fail(`${command} ${args.join(" ")} (in ${cwd}) exited ${status}\n${stdout}\n${stderr}`);
	return stdout;
}

function within(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function assertNoLegacyEngineImports(tarball: string, scratch: string): Promise<void> {
	const extracted = mkdtempSync(join(scratch, "extract-"));
	await run("tar", ["-xzf", tarball, "-C", extracted], scratch);
	const visit = (path: string): void => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
				const source = readFileSync(child, "utf8");
				for (const pattern of LEGACY_ENGINE_IMPORTS) {
					if (pattern.test(source))
						fail(
							`${basename(tarball)}: ${child.slice(extracted.length + 1)} imports a legacy pi engine module (${pattern})`,
						);
				}
			}
		}
	};
	visit(extracted);
}

function serveScope(packed: PackedPackage[]): ReturnType<typeof Bun.serve> {
	const byName = new Map(packed.map((pkg) => [pkg.name, pkg]));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
			const tarballAt = path.indexOf("/-/");
			const pkg = byName.get(tarballAt === -1 ? path : path.slice(0, tarballAt));
			if (!pkg) return new Response("not found", { status: 404 });
			if (tarballAt !== -1) return new Response(pkg.bytes);
			const dist = {
				tarball: `${server.url}${pkg.name}/-/${basename(pkg.tarball)}`,
				integrity: `sha512-${createHash("sha512").update(pkg.bytes).digest("base64")}`,
				shasum: createHash("sha1").update(pkg.bytes).digest("hex"),
			};
			return Response.json({
				name: pkg.name,
				"dist-tags": { latest: pkg.version },
				versions: { [pkg.version]: { ...pkg.manifest, dist } },
			});
		},
	});
	return server;
}

function isolatedEnv(home: string, extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/^(?:OMP_|PI_)/.test(key)) continue;
		if (/^XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME$/.test(key)) continue;
		env[key] = value;
	}
	return { ...env, HOME: home, USERPROFILE: home, ...extra };
}

const packagesDirFlag = process.argv.indexOf("--packages-dir");
const packagesDirArg = packagesDirFlag === -1 ? undefined : process.argv[packagesDirFlag + 1];
if (packagesDirFlag !== -1 && !packagesDirArg) fail("--packages-dir needs a directory");
const packages = publishablePiPackages(packagesDirArg ? resolve(packagesDirArg) : undefined);
if (packages.length === 0) {
	console.log("check-pi-packages: no publishable packages under pi-extensions/");
	process.exit(0);
}
const scope = packages[0]?.name.split("/")[0];
if (!scope?.startsWith("@") || packages.some((pkg) => !pkg.name.startsWith(`${scope}/`)))
	fail(`publishable packages must share one npm scope (got ${packages.map((pkg) => pkg.name)})`);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "thinkrail-pi-parity-")));
if (within(realpathSync(repoRoot), scratch)) fail(`fixture ${scratch} must live outside the repo`);
try {
	const packed: PackedPackage[] = [];
	for (const pkg of packages) {
		const expectation = EXPECTATIONS[pkg.name];
		if (!expectation)
			fail(`${pkg.name} has no parity expectations in scripts/check-pi-packages.ts`);
		if (pkg.piExtensions.length === 0) fail(`${pkg.name} declares no omp.extensions`);
		const tarball = packPiPackage(pkg, scratch);
		await assertNoLegacyEngineImports(tarball, scratch);
		const manifest = JSON.parse(
			await run("tar", ["-xzOf", tarball, "package/package.json"], scratch),
		) as Record<string, unknown>;
		packed.push({
			name: pkg.name,
			version: pkg.version,
			tarball,
			manifest,
			bytes: readFileSync(tarball),
		});
	}

	const fixtureDir = join(scratch, "omp");
	mkdirSync(fixtureDir);
	writeFileSync(
		join(fixtureDir, "package.json"),
		JSON.stringify({ name: "omp-parity-fixture", private: true }),
	);
	await run(
		process.execPath,
		["add", "--exact", `@oh-my-pi/pi-coding-agent@${ompVersion}`, `@oh-my-pi/pi-tui@${ompVersion}`],
		fixtureDir,
	);
	const omp = join(fixtureDir, "node_modules", ".bin", "omp");
	const runner = join(fixtureDir, "pi-package-parity.omp.mjs");
	copyFileSync(join(repoRoot, "scripts", "pi-package-parity.omp.mjs"), runner);
	const installedOmp = (await run(omp, ["--version"], fixtureDir)).trim();
	console.log(`check-pi-packages: bun ${Bun.version}, ${installedOmp}`);

	const registry = serveScope(packed);
	try {
		for (const pkg of packed) {
			const expectation = EXPECTATIONS[pkg.name] as Expectation;
			const home = mkdtempSync(join(scratch, "home-"));
			const agentDir = join(home, ".omp", "agent");
			const pluginDir = join(home, ".omp", "plugins", "node_modules", pkg.name);
			const cwd = mkdtempSync(join(scratch, "project-"));
			const npmrc = join(home, ".npmrc");
			writeFileSync(npmrc, `${scope}:registry=${registry.url}\n`);
			const env = isolatedEnv(home, {
				PI_CODING_AGENT_DIR: agentDir,
				NPM_CONFIG_USERCONFIG: npmrc,
				BUN_INSTALL_CACHE_DIR: join(home, ".bun-cache"),
			});

			await run(omp, ["plugin", "install", pkg.name], cwd, env);

			const spec = {
				name: pkg.name,
				fixtureDir,
				pluginDir,
				agentDir,
				cwd,
				tools: expectation.tools,
				skills: expectation.skills,
				cases: expectation.cases,
			};
			const specPath = join(home, "parity-spec.json");
			writeFileSync(specPath, JSON.stringify(spec));
			const proc = Bun.spawn([process.execPath, runner, specPath], {
				cwd,
				env,
				stdout: "inherit",
				stderr: "pipe",
			});
			const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			if (status !== 0) fail(`${pkg.name} failed vanilla parity under omp\n${stderr}`);

			const size = (
				await run("du", ["-sh", join(home, ".omp", "plugins", "node_modules")], home)
			).split("\t")[0];
			console.log(`  · ${pkg.name}: \`omp plugin install\` tree ${size}`);
		}
	} finally {
		registry.stop(true);
	}
	console.log(
		`check-pi-packages: OK (${packages.length} package(s) installed and loaded by ${installedOmp})`,
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
