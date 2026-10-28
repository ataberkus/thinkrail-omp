import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "trpi-signals-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function signalled(signal: "SIGTERM" | "SIGINT" | "SIGHUP") {
	const script = join(dir, `${signal}.ts`);
	writeFileSync(
		script,
		`import { attachProcessSignals } from ${JSON.stringify(join(import.meta.dir, "boot.ts"))};\n` +
			"let shutdowns = 0;\n" +
			"attachProcessSignals({\n" +
			"  port: 0,\n" +
			"  startAttributionClaim() {},\n" +
			"  stop() {},\n" +
			"  async shutdown() {\n" +
			"    shutdowns++;\n" +
			"    await new Promise((resolve) => setTimeout(resolve, 300));\n" +
			'    process.stderr.write("graceful shutdown finished (" + shutdowns + ")");\n' +
			"  },\n" +
			"});\n" +
			`setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 50);\n` +
			"setInterval(() => {}, 1_000);\n",
	);
	const proc = Bun.spawn([process.execPath, script], {
		env: { ...process.env, NODE_ENV: "production" },
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	return { exitCode: await proc.exited, stderr };
}

test.each([
	"SIGTERM",
	"SIGINT",
	"SIGHUP",
] as const)("%s ends the process with 0 once the host's graceful shutdown has finished", async (signal) => {
	const { exitCode, stderr } = await signalled(signal);
	expect(stderr).toContain("graceful shutdown finished (1)");
	expect(exitCode).toBe(0);
}, 30_000);
