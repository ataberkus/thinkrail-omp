import { getAgentDir, Settings } from "@oh-my-pi/pi-coding-agent";

export interface HostSessionSettings {
	readonly settings: Settings;
	readonly projectTrusted: boolean;
}

export async function loadHostSettings(
	cwd: string,
	projectTrusted: boolean,
	overrides: Readonly<Record<string, unknown>> = {},
): Promise<HostSessionSettings> {
	const agentDir = getAgentDir();
	const settings = await Settings.loadIsolated({
		cwd: projectTrusted ? cwd : agentDir,
		agentDir,
		overrides,
	});
	return { settings, projectTrusted };
}

export function isolatedHostSettings(
	overrides: Readonly<Record<string, unknown>> = {},
): HostSessionSettings {
	return {
		settings: Settings.isolated(overrides),
		projectTrusted: false,
	};
}
