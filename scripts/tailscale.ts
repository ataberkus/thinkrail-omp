#!/usr/bin/env bun

import { findFreePort } from "@thinkrail/shared/freePort";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const preferred = Number(
	(portFlag >= 0 ? args[portFlag + 1] : undefined) ?? process.env.THINKRAIL_PORT ?? 24242,
);
const passthrough = portFlag >= 0 ? args.toSpliced(portFlag, 2) : args;

const ip = tailnetIp();
const port = ip ? await findFreePort(preferred, ip) : preferred;

const host = Bun.spawn(
	[
		"bun",
		"apps/cli/src/index.ts",
		"--tailscale",
		"--no-open",
		"--port",
		String(port),
		...passthrough,
	],
	{ stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);

let desktop: ReturnType<typeof Bun.spawn> | undefined;
const stop = (): void => {
	stopDesktop();
	host.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

if (ip) void openDesktopWhenReady(`http://${ip}:${port}`);

const code = await host.exited;
stopDesktop();
process.exit(code);

function stopDesktop(): void {
	if (!desktop || desktop.exitCode !== null) return;
	if (process.platform === "win32") {
		Bun.spawnSync(["taskkill", "/PID", String(desktop.pid), "/T", "/F"], {
			stdout: "ignore",
			stderr: "ignore",
		});
	} else desktop.kill();
}

function tailnetIp(): string | undefined {
	try {
		const result = Bun.spawnSync(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "ignore" });
		const first = result.stdout.toString().trim().split(/\s+/)[0];
		return result.exitCode === 0 && first ? first : undefined;
	} catch {
		return undefined;
	}
}

async function openDesktopWhenReady(url: string): Promise<void> {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (host.exitCode !== null) return;
		try {
			if ((await fetch(`${url}/health`)).ok) {
				console.log(`thinkrail tailscale: opening the desktop app on ${url}`);
				desktop = Bun.spawn(["bun", "run", "desktop:dev"], {
					env: { ...process.env, THINKRAIL_DESKTOP_HOST_URL: url },
					stdin: "ignore",
					stdout: "inherit",
					stderr: "inherit",
				});
				return;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	console.error(`thinkrail tailscale: host did not answer on ${url}; not opening the desktop app`);
}
