import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const ompBin = join(repoRoot, "node_modules", ".bin", "omp");
const extensionEntry = join(repoRoot, "packages", "pi-subagents", "index.ts");

function fail(message: string): never {
	console.error(`smoke-pure-pi-subagents: FAIL — ${message}`);
	process.exit(1);
}

const agentDir = mkdtempSync(join(tmpdir(), "thinkrail-smoke-pi-agent-"));
const workDir = mkdtempSync(join(tmpdir(), "thinkrail-smoke-cwd-"));
try {
	const userAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	let copied = 0;
	for (const file of ["agent.db", "models.yml", "models.json"]) {
		const src = join(userAgentDir, file);
		if (existsSync(src)) {
			copyFileSync(src, join(agentDir, file));
			copied += 1;
		}
	}
	if (copied === 0) {
		fail(
			`no auth found under ${userAgentDir} — authenticate omp first (this smoke drives a real provider)`,
		);
	}
	const model = process.env.THINKRAIL_E2E_MODEL ?? "anthropic/claude-opus-4-8";

	const prompt =
		'Use the Agent tool with subagent_type "scout" and task "Reply with exactly the single word pong. Do not use any tools." After it returns, reply with the single word done.';
	console.log(`smoke-pure-pi-subagents: running vanilla omp (${model}) …`);
	let stdout = "";
	try {
		stdout = execFileSync(
			ompBin,
			[
				"-p",
				"--mode",
				"json",
				"--no-session",
				"--model",
				model,
				"--thinking",
				"low",
				"-e",
				extensionEntry,
				prompt,
			],
			{
				cwd: workDir,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				encoding: "utf8",
				timeout: 300_000,
				maxBuffer: 64 * 1024 * 1024,
			},
		);
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message?: string };
		fail(
			`omp exited abnormally: ${e.message}\n--- stdout tail ---\n${(e.stdout ?? "").slice(-2000)}\n--- stderr tail ---\n${(e.stderr ?? "").slice(-2000)}`,
		);
	}

	const events = stdout
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
	const agentEnd = events.find((e) => e.type === "tool_execution_end" && e.toolName === "Agent") as
		| { isError?: boolean; result?: { content?: Array<{ type?: string; text?: string }> } }
		| undefined;
	if (!agentEnd) {
		fail(
			`no Agent tool_execution_end in omp's event stream — did the extension load?\n--- stdout tail ---\n${stdout.slice(-2000)}`,
		);
	}
	if (agentEnd.isError) {
		const text = agentEnd.result?.content?.find((c) => c.type === "text")?.text ?? "";
		fail(`the Agent run errored: ${text.slice(0, 500)}`);
	}

	const delegationRoot = join(agentDir, "delegation", "default");
	const parents = existsSync(delegationRoot) ? readdirSync(delegationRoot) : [];
	const transcripts = parents.flatMap((parent) =>
		readdirSync(join(delegationRoot, parent)).filter((f) => f.endsWith(".jsonl")),
	);
	if (transcripts.length === 0) {
		fail(
			`no child transcript under ${delegationRoot} — the default storage binding did not engage`,
		);
	}

	console.log(
		`smoke-pure-pi-subagents: OK — Agent tool completed under vanilla omp; ${transcripts.length} child transcript(s) in ${delegationRoot}`,
	);
} finally {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
}
