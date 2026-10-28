import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

export interface IsolatedAgentDir {
	readonly dir: string;
	restore(): void;
}

export function isolateAgentDir(dir: string): IsolatedAgentDir {
	const previousEnv = process.env.PI_CODING_AGENT_DIR;
	const previousDir = getAgentDir();
	setAgentDir(dir);
	return {
		dir,
		restore() {
			setAgentDir(previousDir);
			if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousEnv;
		},
	};
}
