import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { ToolResponsePendingDetails } from "@thinkrail/contracts";
import { fauxAssistantMessage, isolateAgentDir } from "pi-faux";
import { defaultSessionDirFor, writeFixtureSession } from "./testFixtures";

describe("writeFixtureSession — pinned against omp's real SessionManager", () => {
	test("explicit sessionDir layout: SessionManager.list(cwd, dir) round-trips id/cwd/title/messageCount", async () => {
		const dir = mkdtempSync(join(tmpdir(), "trpi-fixture-explicit-"));
		try {
			const cwd = "/tmp/thinkrail-a5-pin-explicit";
			writeFixtureSession(dir, {
				id: "pin-explicit-1",
				cwd,
				name: "Pin test session",
				messages: [
					{ role: "user", text: "hello", timestamp: 1_700_000_000_000 },
					{ role: "assistant", text: "hi there", timestamp: 1_700_000_001_000 },
				],
			});

			const sessions = await SessionManager.list(cwd, dir);

			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: "pin-explicit-1",
				cwd,
				title: "Pin test session",
				messageCount: 2,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("canonical ask_user_question toolCall + ack details round-trip through SessionManager", async () => {
		const dir = mkdtempSync(join(tmpdir(), "trpi-fixture-toolcall-"));
		try {
			const toolCallId = "ask-fixture-1";
			const args = {
				questions: [
					{
						question: "Which rollout?",
						header: "Rollout",
						options: [
							{ label: "Canary", description: "Start with a small cohort." },
							{ label: "Everyone", description: "Release in one step." },
						],
					},
				],
			};
			const ack: ToolResponsePendingDetails = { kind: "ack" };
			const { path } = writeFixtureSession(dir, {
				id: "pin-toolcall-1",
				cwd: "/tmp/thinkrail-toolcall-pin",
				messages: [
					{ role: "user", text: "Help choose a rollout.", timestamp: 1_700_000_000_000 },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: toolCallId,
								name: "ask_user_question",
								arguments: args,
							},
						],
						stopReason: "toolUse",
						timestamp: 1_700_000_001_000,
					},
					{
						role: "toolResult",
						toolCallId,
						toolName: "ask_user_question",
						content: [{ type: "text", text: "Questions shown to the user." }],
						details: ack,
						isError: false,
						timestamp: 1_700_000_002_000,
					},
				],
			});

			const messages = (await SessionManager.open(path)).buildSessionContext().messages;
			expect(messages).toHaveLength(3);
			expect(messages[1]).toMatchObject({
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: toolCallId, name: "ask_user_question", arguments: args }],
			});
			expect(messages[2]).toMatchObject({
				role: "toolResult",
				toolCallId,
				toolName: "ask_user_question",
				details: { kind: "ack" },
				isError: false,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("default layout: no-arg discovery finds a fixture written under defaultSessionDirFor's encoded dir", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "trpi-fixture-agentdir-"));
		const isolated = isolateAgentDir(agentDir);
		try {
			const cwd = "/tmp/thinkrail-a5-pin-default";
			const sessionDir = defaultSessionDirFor(agentDir, cwd);
			const written = writeFixtureSession(sessionDir, {
				id: "pin-default-1",
				cwd,
				name: "Default layout pin",
				messages: [{ role: "user", text: "seed prompt", timestamp: 1_700_000_000_000 }],
			}).path;

			const sessions = await SessionManager.list(cwd);

			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.path).toBe(written);
			expect(sessions[0]).toMatchObject({
				id: "pin-default-1",
				cwd,
				title: "Default layout pin",
				messageCount: 1,
			});
		} finally {
			isolated.restore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("default layout: omp's real no-arg listAll() finds what HistoryIndex's own default walk must also find", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "trpi-fixture-listall-"));
		const isolated = isolateAgentDir(agentDir);
		try {
			const cwd = "/tmp/thinkrail-a5-pin-listall";
			const sessionDir = defaultSessionDirFor(agentDir, cwd);
			writeFixtureSession(sessionDir, {
				id: "pin-listall-1",
				cwd,
				messages: [{ role: "user", text: "seed prompt", timestamp: 1_700_000_000_000 }],
			});

			const sessions = await SessionManager.listAll();

			expect(sessions.map((s) => s.id)).toContain("pin-listall-1");
		} finally {
			isolated.restore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

test("omp records a new transcript's cwd verbatim, so stored directories rely on the host resolving it first", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trpi-fixture-cwd-"));
	try {
		const cwd = resolve(dir, "repo");
		const sessionDir = join(dir, "sessions");
		const unresolved = `${cwd}${sep}.${sep}`;
		expect(SessionManager.create(unresolved, sessionDir).getCwd()).toBe(unresolved);

		const manager = SessionManager.create(resolve(unresolved), sessionDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1_700_000_000_000 });
		manager.appendMessage(fauxAssistantMessage("hi"));
		await manager.flush();

		expect(manager.getCwd()).toBe(cwd);
		expect((await SessionManager.list(cwd, sessionDir)).map((info) => info.cwd)).toEqual([cwd]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
