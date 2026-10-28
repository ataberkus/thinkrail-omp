import { postmortem } from "@oh-my-pi/pi-utils";
import { findFreePort } from "@thinkrail/shared/freePort";
import { resolveShellEnv } from "@thinkrail/shared/shellEnv";
import { getPiRuntime, migratePiAgentDataOnBoot } from "../agent";
import { reportError } from "../analytics";
import { initializeJbcentralRuntime } from "../auth";
import { applyHostEnvironment } from "../environment";
import { initLogging, logger } from "../log";
import { installCrashLog } from "./crashLog";
import { type CreateServerOptions, createServer, type RunningServer } from "./server";

export interface BootHostOptions {
	port: number;
	host: string;
	portMode: "exact" | "free";
	staticDir?: string;
	projectPath?: string;
	appVersion?: string;
	analytics?: CreateServerOptions["analytics"];
	hostUpdate?: CreateServerOptions["hostUpdate"];
	verbose?: boolean;
	resolveShellEnv?: boolean;
}

const log = logger("host");

export interface BootedHost {
	readonly server: RunningServer;
	readonly port: number;
	readonly requested: number;
}

const SIGNAL_REASONS: ReadonlySet<postmortem.Reason> = new Set([
	postmortem.Reason.SIGINT,
	postmortem.Reason.SIGTERM,
	postmortem.Reason.SIGHUP,
]);

export function attachProcessSignals(server: RunningServer): RunningServer {
	const unregister = postmortem.register(
		"thinkrail-host",
		async (reason) => {
			if (!SIGNAL_REASONS.has(reason)) return;
			await server.shutdown();
			postmortem.exitProcess(0);
		},
		{ exitOnly: true },
	);
	const stop = (): void => {
		unregister();
		server.stop();
	};
	const shutdown = (): Promise<void> => {
		unregister();
		return server.shutdown();
	};
	return {
		get port() {
			return server.port;
		},
		startAttributionClaim: () => server.startAttributionClaim(),
		stop,
		shutdown,
	};
}

export async function bootHost(options: BootHostOptions): Promise<BootedHost> {
	const shellEnv = options.resolveShellEnv ? resolveShellEnv() : undefined;
	await initLogging({
		...(options.verbose ? { level: "debug" as const } : {}),
		...(options.appVersion ? { appVersion: options.appVersion } : {}),
	});
	installCrashLog(options.appVersion);
	await shellEnv;
	applyHostEnvironment();
	await initializeJbcentralRuntime();
	await migratePiAgentDataOnBoot(async () => (await getPiRuntime()).authStorage);

	const requested = options.port;
	const port =
		options.portMode === "free" ? await findFreePort(requested, options.host) : requested;
	const running = await createServer({
		port,
		host: options.host,
		...(options.staticDir ? { staticDir: options.staticDir } : {}),
		...(options.projectPath ? { projectPath: options.projectPath } : {}),
		...(options.appVersion ? { appVersion: options.appVersion } : {}),
		...(options.analytics ? { analytics: options.analytics } : {}),
		...(options.hostUpdate ? { hostUpdate: options.hostUpdate } : {}),
	});
	const server = attachProcessSignals(running);
	log.info(`listening on port ${server.port}`);
	return { server, port: server.port, requested };
}

export function reportDesktopError(error: unknown, scope: string): void {
	reportError(error, { source: "desktop", handled: true, scope });
}
