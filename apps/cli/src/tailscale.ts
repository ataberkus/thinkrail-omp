import { isIPv4 } from "node:net";
import { spawnSyncCaptured } from "@thinkrail/shared/spawn";

export interface TailscaleAddress {
	ip: string;
	dnsName: string | null;
}

const STATUS_TIMEOUT_MS = 5_000;

interface TailscaleStatus {
	BackendState?: unknown;
	Self?: { DNSName?: unknown; TailscaleIPs?: unknown } | null;
	CurrentTailnet?: { MagicDNSEnabled?: unknown } | null;
}

export function parseTailscaleStatus(json: string): TailscaleAddress {
	let status: TailscaleStatus;
	try {
		status = JSON.parse(json) as TailscaleStatus;
	} catch {
		throw new Error("Tailscale returned an unreadable status; check that Tailscale is running.");
	}
	if (status.BackendState !== "Running") {
		const state = typeof status.BackendState === "string" ? status.BackendState : "unknown";
		throw new Error(
			`Tailscale is not connected (state: ${state}); run \`tailscale up\` and log in, then retry.`,
		);
	}
	const ips = Array.isArray(status.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : [];
	const ip = ips.find(
		(candidate): candidate is string => typeof candidate === "string" && isIPv4(candidate),
	);
	if (!ip) {
		throw new Error(
			"Tailscale reports no IPv4 address for this machine; enable IPv4 for it in the tailnet, then retry.",
		);
	}
	const rawName = status.Self?.DNSName;
	const name = typeof rawName === "string" ? rawName.replace(/\.$/, "") : "";
	const magicDns = status.CurrentTailnet?.MagicDNSEnabled !== false;
	return { ip, dnsName: magicDns && name !== "" ? name : null };
}

export function resolveTailscaleAddress(): TailscaleAddress {
	const run = spawnSyncCaptured(["tailscale", "status", "--json"], {
		timeoutMs: STATUS_TIMEOUT_MS,
	});
	if (!run.launched) {
		throw new Error(
			"Tailscale CLI not found; install Tailscale (https://tailscale.com/download) and put `tailscale` on PATH.",
		);
	}
	if (run.exitCode === null) {
		throw new Error(
			`\`tailscale status\` did not answer within ${STATUS_TIMEOUT_MS / 1000}s; check that the Tailscale service is running.`,
		);
	}
	if (run.exitCode !== 0 && !run.stdout.trim().startsWith("{")) {
		const reason = run.stderr.trim().split("\n")[0] ?? "";
		throw new Error(
			`Tailscale is not running${reason ? ` (${reason})` : ""}; start the Tailscale app or service, then retry.`,
		);
	}
	return parseTailscaleStatus(run.stdout);
}
