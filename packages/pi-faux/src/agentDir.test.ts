import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { isolateAgentDir } from "../index";

const root = mkdtempSync(join(tmpdir(), "pi-faux-agent-dir-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a test's agent directory reaches omp's resolver and is restored", () => {
	const before = getAgentDir();
	const isolated = isolateAgentDir(join(root, "agent"));
	try {
		expect(getAgentDir()).toBe(join(root, "agent"));
		expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
		expect(SessionManager.getDefaultSessionDir("/somewhere")).toStartWith(join(root, "agent"));
	} finally {
		isolated.restore();
	}
	expect(getAgentDir()).toBe(before);
});
