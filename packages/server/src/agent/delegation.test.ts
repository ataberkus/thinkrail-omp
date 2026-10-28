import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { type SessionEntry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
	SUBAGENT_COMPLETION_CUSTOM_TYPE,
	type DelegationRunDetails as WireRunDetails,
} from "@thinkrail/contracts";
import { errorCodeOf } from "@thinkrail/shared/codedError";
import { type DelegationRunDetails as CoreRunDetails, delegationSessionDir } from "pi-delegation";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
} from "pi-faux";
import { SUBAGENT_COMPLETION_MESSAGE } from "pi-subagents";
import { setTrashImplementationForTests } from "../trash";
import {
	createSession,
	deleteSession,
	disposeAllSessions,
	getSessionStats,
	liveParentContext,
	recordSessionUsage,
	removeSession,
	removeWorkspaceSessions,
	setSessionManagerFactory,
	setSessionPublisher,
	setSkillAdmissionResolver,
	settleSessionsForShutdown,
} from "./agentSessionManager";
import {
	delegationRootDir,
	delegationServiceFor,
	readChildTranscript,
	reconcileSessionSubagentUsage,
	refreshSubagentConcurrency,
	setSubagentConcurrencyResolver,
} from "./delegation";
import { ModelRuntime } from "./modelRuntime";
import { configurePiRuntime } from "./piRuntime";
import { admissionContextFor } from "./skillAdmission";
import { childFileUsage, SUBAGENT_USAGE_KIND } from "./subagentUsage";
import { usagePurpose } from "./usagePurpose";

function fauxModel(id: string, input: ("text" | "image")[] = ["text"]) {
	return {
		id,
		name: id,
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

const faux = createFauxCore({
	provider: "faux",
	api: "trdel-faux",
	models: [fauxModel("faux")],
	tokensPerSecond: 4000,
});

let heldResponse: { gate: Promise<void>; reached: () => void } | undefined;

/** The faux stream; a held response pauses after its first delta, so an abort keeps its spend. */
function holdingStream(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const hold = heldResponse;
	heldResponse = undefined;
	const inner = faux.streamSimple(model, context, options);
	if (!hold) return inner;
	const outer = createAssistantMessageEventStream();
	void (async () => {
		let held = false;
		for await (const event of inner) {
			outer.push(event);
			if (!held && event.type === "text_delta") {
				held = true;
				await Bun.sleep(25);
				hold.reached();
				await hold.gate;
			}
		}
		outer.end();
	})();
	return outer;
}

function registerFauxProvider(
	runtime: ModelRuntime,
	providerId: string,
	model: ReturnType<typeof fauxModel>,
): void {
	runtime.registerProvider(providerId, {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: holdingStream,
		models: [{ ...model, api: faux.api }],
	});
}

async function fauxRuntime(providerId: string, modelId: string): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		inMemoryCredentials: true,
		modelsPath: null,
		allowModelNetwork: false,
	});
	registerFauxProvider(runtime, providerId, fauxModel(modelId));
	return runtime;
}

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

let isolatedAgentDir: IsolatedAgentDir;
let priorDataDir: string | undefined;
let priorOffline: string | undefined;
let baseRuntime: ModelRuntime;

beforeAll(async () => {
	isolatedAgentDir = isolateAgentDir(tmpDir("trdel-agentdir-"));
	priorDataDir = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = tmpDir("trdel-data-");
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";

	baseRuntime = await fauxRuntime("faux", "faux");
	configurePiRuntime(baseRuntime);
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
	setSessionPublisher(() => {});
});

afterAll(() => {
	disposeAllSessions();
	configurePiRuntime(null);
	isolatedAgentDir.restore();
	if (priorDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = priorDataDir;
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const isSubagentUsage = (entry: SessionEntry) =>
	entry.type === "model_usage" && entry.purpose.startsWith(`${SUBAGENT_USAGE_KIND}:`);

const subagentRecord = (childSessionId: string) => ({
	type: "model_usage",
	purpose: usagePurpose(SUBAGENT_USAGE_KIND, childSessionId),
});

test("host embedding: projection, per-workspace service, transcript store, cascades, retention", async () => {
	const cwd = tmpDir("trdel-ws-");
	const { sessionId } = await createSession({ cwd, workspaceId: "ws-del" });

	const parent = liveParentContext(sessionId);
	expect(parent?.cwd).toBe(cwd);
	expect(parent?.model?.provider).toBe("faux");
	expect(parent?.modelRegistry).toBe(baseRuntime.modelRegistry);
	expect(liveParentContext("not-a-session")).toBeUndefined();

	const service = delegationServiceFor("ws-del");
	expect(delegationServiceFor("ws-del")).toBe(service);
	expect(delegationServiceFor("ws-other")).not.toBe(service);

	faux.setResponses([fauxAssistantMessage("CHILD_DONE")]);
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const outcome = await child.runQueued("Report.");
	expect(outcome.status).toBe("completed");
	expect(child.record.sessionFile.startsWith(join(delegationRootDir(), "ws-del"))).toBe(true);

	const read = readChildTranscript("ws-del", sessionId, child.sessionId);
	expect(JSON.stringify(read.messages)).toContain("CHILD_DONE");
	expect(read.status).toBe("completed");

	const childManager = await SessionManager.open(child.record.sessionFile);
	const lastEntryId = childManager.getEntries().at(-1)?.id;
	if (!lastEntryId) throw new Error("expected child entries");
	childManager.appendCompaction("COMPACTED_CONTEXT", undefined, lastEntryId, 12_345);
	await childManager.close();
	const compacted = readChildTranscript("ws-del", sessionId, child.sessionId);
	expect(
		compacted.messages.some(
			(message) => message.role === "compactionSummary" && message.summary === "COMPACTED_CONTEXT",
		),
	).toBe(true);

	await removeSession(sessionId);
	expect(service.findChild(child.sessionId)).toBeUndefined();
	const afterDispose = readChildTranscript("ws-del", sessionId, child.sessionId);
	expect(afterDispose.messages.length).toBeGreaterThan(0);
	expect(afterDispose.status).toBeUndefined();

	await removeWorkspaceSessions("ws-del");
	let missing: unknown;
	try {
		readChildTranscript("ws-del", sessionId, child.sessionId);
	} catch (err) {
		missing = err;
	}
	expect(String(missing)).toContain("No transcript found");
	expect(errorCodeOf(missing)).toBe("SUBAGENT_TRANSCRIPT_NOT_FOUND");
});

async function createSessionWith(
	factory: (dir: string) => SessionManager,
	input: Parameters<typeof createSession>[0],
) {
	setSessionManagerFactory(factory);
	try {
		return await createSession(input);
	} finally {
		setSessionManagerFactory((dir) => SessionManager.inMemory(dir));
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
}

function gatedChildResponse(): { release: () => void; streaming: Promise<void> } {
	const gate = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	heldResponse = { gate: gate.promise, reached: reached.resolve };
	faux.setResponses([fauxAssistantMessage("GATED_DONE")]);
	return { release: gate.resolve, streaming: reached.promise };
}

test("a child run's usage delta lands in the parent's pi totals and invalidates its stats", async () => {
	const cwd = tmpDir("trdel-usage-");
	let parentManager: SessionManager | undefined;
	const { sessionId } = await createSessionWith(
		(dir) => {
			parentManager = SessionManager.inMemory(dir);
			return parentManager;
		},
		{ cwd, workspaceId: "ws-usage" },
	);
	const published: unknown[] = [];
	setSessionPublisher((payload) => {
		if (payload.sessionId === sessionId) published.push(payload.event);
	});
	try {
		expect(getSessionStats(sessionId).tokens.total).toBe(0);
		faux.setResponses([fauxAssistantMessage("CHILD_DONE")]);
		const child = await delegationServiceFor("ws-usage").createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "You are a test scout." },
		});
		const { usage } = (await child.runQueued("Report.")).details;
		expect(usage.input + usage.output).toBeGreaterThan(0);

		const { tokens } = getSessionStats(sessionId);
		expect(tokens).toMatchObject({
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
		});
		const recorded = parentManager?.getEntries().filter(isSubagentUsage);
		expect(recorded).toMatchObject([
			{ ...subagentRecord(child.sessionId), api: faux.api, provider: "faux", model: "faux" },
		]);
		expect(published).toContainEqual({ type: "entry_appended", entryType: "model_usage" });

		await child.dispose();
		expect(
			childFileUsage(child.sessionId, readFileSync(child.record.sessionFile, "utf8")),
		).toMatchObject({
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: { total: usage.cost },
			},
		});
		await reconcileSessionSubagentUsage("ws-usage", sessionId, () => parentManager?.getEntries());
		expect(parentManager?.getEntries().filter(isSubagentUsage)).toHaveLength(1);
	} finally {
		setSessionPublisher(() => {});
		await removeSession(sessionId);
	}
});

test("the subagent totals mirror matches omp's own totals for every spend source", async () => {
	const cwd = tmpDir("trdel-parity-");
	const spend = (seed: number, total: number) => ({
		input: seed,
		output: seed + 1,
		cacheRead: seed + 2,
		cacheWrite: seed + 3,
		totalTokens: 4 * seed + 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	});
	const transcript = SessionManager.create(cwd, tmpDir("trdel-parity-sessions-"));
	const owner = () => ({
		sessionId: transcript.getSessionId(),
		parentId: transcript.getLeafId(),
	});
	const call = (purpose: string, usage: ReturnType<typeof spend>) => ({
		purpose,
		api: faux.api,
		provider: "faux",
		model: "faux",
		usage,
		stopReason: "stop" as const,
	});
	transcript.appendMessage({ role: "user", content: "Find it.", timestamp: Date.now() });
	const askedId = transcript.appendMessage({
		...fauxAssistantMessage([fauxToolCall("task", { q: "it" }, { id: "call-1" })], {
			stopReason: "toolUse",
		}),
		usage: spend(10, 0.011),
	});
	const resultId = transcript.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "task",
		content: [{ type: "text", text: "found" }],
		details: { usage: spend(20, 0.022) },
		isError: false,
		timestamp: Date.now(),
	});
	transcript.appendModelUsage(call("compaction", spend(30, 0.033)), owner());
	transcript.appendCompaction("Compacted.", undefined, askedId, 1_000);
	transcript.branchWithSummary(askedId, "Abandoned branch.");
	transcript.appendModelUsage(call("branch_summary", spend(40, 0.044)), owner());
	transcript.appendModelUsage(call("cache_warm", spend(50, 0.055)), owner());
	transcript.appendModelUsage(call("late", spend(60, 0.066)), {
		sessionId: transcript.getSessionId(),
		parentId: resultId,
	});
	const file = transcript.getSessionFile();
	if (!file) throw new Error("expected a persisted transcript");
	await transcript.close();

	const omp = (await SessionManager.open(file)).getUsageStatistics();
	expect(omp).toMatchObject({ input: 210, output: 216, cacheRead: 222, cacheWrite: 228 });
	expect(omp.cost).toBeCloseTo(0.231, 12);
	expect(transcript.getUsageStatistics()).toMatchObject({
		input: omp.input,
		output: omp.output,
		cacheRead: omp.cacheRead,
		cacheWrite: omp.cacheWrite,
	});
	const mirror = childFileUsage(transcript.getSessionId(), readFileSync(file, "utf8"));
	expect(mirror?.usage).toMatchObject({
		input: omp.input,
		output: omp.output,
		cacheRead: omp.cacheRead,
		cacheWrite: omp.cacheWrite,
	});
	expect(mirror?.usage.cost.total).toBeCloseTo(omp.cost, 12);
});

async function parentWithGatedChild(workspaceId: string) {
	let parentManager: SessionManager | undefined;
	const cwd = tmpDir(`trdel-${workspaceId}-`);
	const { sessionId } = await createSessionWith(
		(dir) => {
			parentManager = SessionManager.inMemory(dir);
			return parentManager;
		},
		{ cwd, workspaceId },
	);
	const { release, streaming } = gatedChildResponse();
	const child = await delegationServiceFor(workspaceId).createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long background job.");
	await streaming;
	let atChildDisposal: SessionEntry[] | undefined;
	delegationServiceFor(workspaceId).onLifecycle((event) => {
		if (event.type === "child-disposed" && event.sessionId === child.sessionId)
			atChildDisposal = parentManager?.getEntries().filter(isSubagentUsage);
	});
	const usageEntries = () =>
		atChildDisposal ?? parentManager?.getEntries().filter(isSubagentUsage) ?? [];
	return { cwd, sessionId, child, run, release, usageEntries, parentManager };
}

test("attaching a chat recovers the spend of children a crashed host never recorded", async () => {
	const cwd = tmpDir("trdel-crash-");
	let parentManager: SessionManager | undefined;
	let orphanId = "";
	const { sessionId } = await createSessionWith(
		(dir) => {
			parentManager = SessionManager.inMemory(dir);
			const orphan = SessionManager.create(
				cwd,
				delegationSessionDir(delegationRootDir(), "ws-crash", parentManager.getSessionId()),
			);
			orphan.appendMessage({ role: "user", content: "Long job.", timestamp: Date.now() });
			orphan.appendMessage({
				...fauxAssistantMessage("partial"),
				provider: "faux",
				model: "faux",
				usage: {
					input: 120,
					output: 30,
					cacheRead: 4_000,
					cacheWrite: 500,
					totalTokens: 4_650,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
			});
			orphanId = orphan.getSessionId();
			return parentManager;
		},
		{ cwd, workspaceId: "ws-crash" },
	);
	try {
		await waitFor(() => getSessionStats(sessionId).tokens.total > 0);
		expect(getSessionStats(sessionId)).toMatchObject({
			tokens: { input: 120, output: 30, cacheRead: 4_000, cacheWrite: 500 },
			cost: 0.25,
		});
		const usageEntries = () => parentManager?.getEntries().filter(isSubagentUsage);
		expect(usageEntries()).toMatchObject([
			{ ...subagentRecord(orphanId), provider: "faux", model: "faux" },
		]);
		await reconcileSessionSubagentUsage("ws-crash", sessionId, () => parentManager?.getEntries());
		expect(usageEntries()).toHaveLength(1);
	} finally {
		await removeSession(sessionId);
	}
});

test("closing a chat still records the usage of a child its cascade stops", async () => {
	const { sessionId, child, run, release, usageEntries } = await parentWithGatedChild("ws-close");
	const closed = removeSession(sessionId);
	await waitFor(() => liveParentContext(sessionId) === undefined);
	release();
	await Promise.all([closed, run]);
	expect(usageEntries()).toMatchObject([subagentRecord(child.sessionId)]);
});

test("deleting a chat never appends usage to its trashed transcript", async () => {
	const { cwd, sessionId, run, release, usageEntries } = await parentWithGatedChild("ws-delusage");
	const deleted = deleteSession(sessionId, "ws-delusage", cwd);
	await waitFor(() => liveParentContext(sessionId) === undefined);
	release();
	await Promise.all([deleted, run]);
	expect(usageEntries()).toEqual([]);
});

test("a failed usage write never fails the child run", async () => {
	const { sessionId, child, run, release, usageEntries, parentManager } =
		await parentWithGatedChild("ws-enospc");
	if (!parentManager) throw new Error("expected a parent session manager");
	parentManager.appendModelUsage = () => {
		throw new Error("ENOSPC: no space left on device");
	};
	try {
		release();
		expect((await run).status).toBe("completed");
		expect(child.snapshot?.status).toBe("completed");
		expect(usageEntries()).toEqual([]);
	} finally {
		await removeSession(sessionId);
	}
});

const SUBAGENT_USAGE_LINE = `"purpose":"${SUBAGENT_USAGE_KIND}:`;

function ioError(message: string): Error {
	return Object.assign(new Error(message), { code: "EIO" });
}

/** Fails omp's own disk writes of subagent usage lines; `tear` lands a prefix first, `keepTornBytes` defeats the rollback. */
function failUsageWrites(
	options: { times?: number; tear?: boolean; keepTornBytes?: boolean } = {},
) {
	const realWrite = fs.writeSync;
	let remaining = options.times ?? Number.POSITIVE_INFINITY;
	let failures = 0;
	const write = spyOn(fs, "writeSync").mockImplementation(
		(
			fd: number,
			data: string | NodeJS.ArrayBufferView,
			offset?: unknown,
			length?: unknown,
			position?: unknown,
		): number => {
			if (remaining > 0 && Buffer.isBuffer(data) && data.includes(SUBAGENT_USAGE_LINE)) {
				remaining--;
				failures++;
				if (options.tear) realWrite(fd, data, 0, 20);
				throw ioError("EIO: i/o error, write");
			}
			const written: unknown = Reflect.apply(realWrite, fs, [fd, data, offset, length, position]);
			if (typeof written !== "number") throw new Error("expected a byte count");
			return written;
		},
	);
	const truncate = options.keepTornBytes
		? spyOn(fs, "ftruncateSync").mockImplementation(() => {
				throw ioError("EIO: i/o error, ftruncate");
			})
		: undefined;
	return {
		failures: () => failures,
		restore() {
			write.mockRestore();
			truncate?.mockRestore();
		},
	};
}

async function persistedParent(workspaceId: string) {
	let manager: SessionManager | undefined;
	const cwd = tmpDir(`trdel-${workspaceId}-`);
	const { sessionId } = await createSessionWith(
		(dir) => {
			manager = SessionManager.create(dir);
			return manager;
		},
		{ cwd, workspaceId },
	);
	if (!manager) throw new Error("expected a parent session manager");
	manager.appendMessage({ role: "user", content: "BEFORE", timestamp: Date.now() });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file || !existsSync(file)) throw new Error("expected a persisted parent transcript");
	return { cwd, sessionId, manager, file };
}

function userTexts(manager: SessionManager): string[] {
	return manager
		.buildSessionContext()
		.messages.flatMap((message) =>
			message.role === "user" && typeof message.content === "string" ? [message.content] : [],
		);
}

async function subagentUsageOnDisk(file: string) {
	return (await SessionManager.open(file)).getEntries().filter(isSubagentUsage);
}

function summedInput(entries: readonly SessionEntry[]): number {
	return entries.reduce(
		(sum, entry) => sum + (entry.type === "model_usage" ? entry.usage.input : 0),
		0,
	);
}

const subagentSpend = (input: number, note: string) => ({
	kind: SUBAGENT_USAGE_KIND,
	provider: "faux",
	model: "faux",
	note,
	usage: {
		input,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	},
});

test("a usage write omp kept only in memory never cuts the reopened history", async () => {
	const { sessionId, manager, file } = await persistedParent("ws-memonly");
	const { release, streaming } = gatedChildResponse();
	const faults = failUsageWrites();
	try {
		const child = await delegationServiceFor("ws-memonly").createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "You are a test scout." },
		});
		const run = child.runQueued("Long background job.");
		await streaming;
		release();
		const outcome = await run;
		faults.restore();
		expect(faults.failures()).toBeGreaterThan(0);
		expect(outcome.status).toBe("completed");
		expect(getSessionStats(sessionId).tokens.input).toBe(outcome.details.usage.input);
		expect(await subagentUsageOnDisk(file)).toEqual([]);

		manager.appendMessage({ role: "user", content: "AFTER", timestamp: Date.now() });
		const reopened = await SessionManager.open(file);
		expect(userTexts(reopened)).toEqual(["BEFORE", "AFTER"]);
		expect(summedInput(reopened.getEntries().filter(isSubagentUsage))).toBe(
			outcome.details.usage.input,
		);
	} finally {
		faults.restore();
		release();
		await removeSession(sessionId);
	}
});

test("reopening a chat restores subagent spend that was recorded only in memory", async () => {
	const { cwd, sessionId, file } = await persistedParent("ws-reopen");
	faux.setResponses([fauxAssistantMessage("CHILD_DONE")]);
	const child = await delegationServiceFor("ws-reopen").createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const faults = failUsageWrites();
	const outcome = await child.runQueued("Report.").finally(() => faults.restore());
	expect(faults.failures()).toBeGreaterThan(0);
	const { usage } = outcome.details;
	await removeSession(sessionId);
	expect(await subagentUsageOnDisk(file)).toEqual([]);

	const reopenedManager = await SessionManager.open(file);
	const reopened = await createSessionWith(() => reopenedManager, {
		cwd,
		workspaceId: "ws-reopen",
	});
	try {
		expect(reopened.sessionId).toBe(sessionId);
		await waitFor(() => getSessionStats(sessionId).tokens.input === usage.input);
		expect(getSessionStats(sessionId).tokens).toMatchObject({
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
		});
	} finally {
		await removeSession(sessionId);
	}
});

test("a torn usage append is cut back so the next entry stays readable", async () => {
	const { sessionId, manager, file } = await persistedParent("ws-torn");
	const sizeBefore = statSync(file).size;
	const faults = failUsageWrites({ times: 1, tear: true });
	try {
		expect(recordSessionUsage(sessionId, subagentSpend(40, "child-torn"))).toBe(true);
		faults.restore();
		expect(faults.failures()).toBe(1);
		expect(statSync(file).size).toBe(sizeBefore);
		expect(getSessionStats(sessionId).tokens.input).toBe(40);

		manager.appendMessage({ role: "user", content: "AFTER", timestamp: Date.now() });
		const reopened = await SessionManager.open(file);
		expect(userTexts(reopened)).toEqual(["BEFORE", "AFTER"]);
		expect(reopened.getEntries().filter(isSubagentUsage)).toMatchObject([
			{ ...subagentRecord("child-torn"), usage: { input: 40 } },
		]);
	} finally {
		faults.restore();
		await removeSession(sessionId);
	}
});

test("usage accounting survives a throwing publisher and an unreadable transcript path", async () => {
	const { sessionId, manager, file } = await persistedParent("ws-besteffort");
	const getSessionFile = manager.getSessionFile.bind(manager);
	try {
		setSessionPublisher(() => {
			throw new Error("socket closed");
		});
		expect(recordSessionUsage(sessionId, subagentSpend(10, "child-a"))).toBe(true);
		setSessionPublisher(() => {});
		manager.getSessionFile = () => join(file, "missing");
		expect(recordSessionUsage(sessionId, subagentSpend(20, "child-b"))).toBe(true);
		manager.getSessionFile = getSessionFile;
		expect(await subagentUsageOnDisk(file)).toHaveLength(2);
	} finally {
		setSessionPublisher(() => {});
		manager.getSessionFile = getSessionFile;
		await removeSession(sessionId);
	}
});

test("a torn append omp cannot truncate never throws and the next write heals the transcript", async () => {
	const { sessionId, manager, file } = await persistedParent("ws-notrunc");
	const sizeBefore = statSync(file).size;
	const faults = failUsageWrites({ times: 1, tear: true, keepTornBytes: true });
	try {
		expect(recordSessionUsage(sessionId, subagentSpend(30, "child-c"))).toBe(true);
		faults.restore();
		expect(statSync(file).size).toBeGreaterThan(sizeBefore);
		expect(getSessionStats(sessionId).tokens.input).toBe(30);

		manager.appendMessage({ role: "user", content: "AFTER", timestamp: Date.now() });
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
		const reopened = await SessionManager.open(file);
		expect(userTexts(reopened)).toEqual(["BEFORE", "AFTER"]);
		expect(reopened.getEntries().filter(isSubagentUsage)).toMatchObject([
			{ ...subagentRecord("child-c"), usage: { input: 30 } },
		]);
	} finally {
		faults.restore();
		await removeSession(sessionId);
	}
});

test("a failed deletion recovers the usage of a child that settled while trash was pending", async () => {
	let reportTrashStarted: () => void = () => {};
	const trashStarted = new Promise<void>((resolve) => {
		reportTrashStarted = resolve;
	});
	let failTrash: () => void = () => {};
	const trashOutcome = new Promise<void>((_resolve, reject) => {
		failTrash = () => reject(new Error("recycle bin unavailable"));
	});
	setTrashImplementationForTests(async () => {
		reportTrashStarted();
		await trashOutcome;
	});
	const { cwd, sessionId, file } = await persistedParent("ws-trashfail");
	const { release, streaming } = gatedChildResponse();
	try {
		const child = await delegationServiceFor("ws-trashfail").createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "You are a test scout." },
		});
		const run = child.runQueued("Long background job.");
		await streaming;
		const deleting = deleteSession(sessionId, "ws-trashfail", cwd);
		await trashStarted;
		release();
		expect((await run).details.usage.input).toBeGreaterThan(0);
		expect(await subagentUsageOnDisk(file)).toEqual([]);

		failTrash();
		await expect(deleting).rejects.toThrow("recycle bin unavailable");
		await waitFor(
			() =>
				liveParentContext(sessionId) !== undefined && getSessionStats(sessionId).tokens.input > 0,
		);
		expect(await subagentUsageOnDisk(file)).toMatchObject([subagentRecord(child.sessionId)]);
	} finally {
		failTrash();
		setTrashImplementationForTests(undefined);
		await removeSession(sessionId);
	}
});

function twoStepChildResponses(): { release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("no_such_tool", {})], { stopReason: "toolUse" }),
		async () => {
			await gate;
			return fauxAssistantMessage("DONE");
		},
	]);
	return { release };
}

function scoutChild(workspaceId: string, parent: string) {
	return delegationServiceFor(workspaceId).createChild({
		parent,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
}

const tokenCounts = (usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}) => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
});

async function inMemoryParent(workspaceId: string) {
	let manager: SessionManager | undefined;
	const { sessionId } = await createSessionWith(
		(dir) => {
			manager = SessionManager.inMemory(dir);
			return manager;
		},
		{ cwd: tmpDir(`trdel-${workspaceId}-`), workspaceId },
	);
	if (!manager) throw new Error("expected a parent session manager");
	const parent = manager;
	const usageEntries = () => parent.getEntries().filter(isSubagentUsage);
	return { sessionId, manager: parent, usageEntries };
}

test("a running subagent's spend reaches its parent after each response, before the run ends", async () => {
	const { sessionId, manager, usageEntries } = await inMemoryParent("ws-live");
	const { release } = twoStepChildResponses();
	try {
		const child = await scoutChild("ws-live", sessionId);
		const run = child.runQueued("Two steps.");
		await waitFor(() => usageEntries().length > 0);
		expect(child.snapshot?.status).toBe("running");
		const firstStep = getSessionStats(sessionId).tokens.total;
		expect(firstStep).toBeGreaterThan(0);

		release();
		const { usage } = (await run).details;
		const { tokens } = getSessionStats(sessionId);
		expect(tokens.total).toBeGreaterThan(firstStep);
		expect(tokenCounts(tokens)).toEqual(tokenCounts(usage));
		const recorded = usageEntries().length;
		expect(recorded).toBeGreaterThanOrEqual(2);
		await child.dispose();
		await reconcileSessionSubagentUsage("ws-live", sessionId, () => manager.getEntries());
		expect(usageEntries()).toHaveLength(recorded);
	} finally {
		release();
		await removeSession(sessionId);
	}
});

test("a live-recorded run stays exact after its chat is reopened", async () => {
	const { cwd, sessionId, file } = await persistedParent("ws-livereopen");
	const { release } = twoStepChildResponses();
	let reopened: SessionManager | undefined;
	try {
		const child = await scoutChild("ws-livereopen", sessionId);
		const run = child.runQueued("Two steps.");
		await waitFor(() => getSessionStats(sessionId).tokens.total > 0);
		release();
		const { usage } = (await run).details;
		await removeSession(sessionId);
		const recorded = (await subagentUsageOnDisk(file)).length;
		expect(recorded).toBeGreaterThanOrEqual(2);

		const reopenedManager = await SessionManager.open(file);
		reopened = reopenedManager;
		await createSessionWith(() => reopenedManager, { cwd, workspaceId: "ws-livereopen" });
		await reconcileSessionSubagentUsage("ws-livereopen", sessionId, () => reopened?.getEntries());
		expect(reopened?.getEntries().filter(isSubagentUsage)).toHaveLength(recorded);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
	} finally {
		release();
		await removeSession(sessionId);
	}
});

test("a progress write kept only in memory is neither recounted nor lost after reopening", async () => {
	const { cwd, sessionId, file } = await persistedParent("ws-progressfail");
	const { release } = twoStepChildResponses();
	const faults = failUsageWrites();
	try {
		const child = await scoutChild("ws-progressfail", sessionId);
		const run = child.runQueued("Two steps.");
		await waitFor(() => getSessionStats(sessionId).tokens.total > 0);
		faults.restore();
		expect(faults.failures()).toBeGreaterThan(0);
		release();
		const { usage } = (await run).details;
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
		await removeSession(sessionId);
		expect((await subagentUsageOnDisk(file)).length).toBeGreaterThan(0);

		const reopenedManager = await SessionManager.open(file);
		await createSessionWith(() => reopenedManager, {
			cwd,
			workspaceId: "ws-progressfail",
		});
		await waitFor(() => getSessionStats(sessionId).tokens.input === usage.input);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
	} finally {
		faults.restore();
		release();
		await removeSession(sessionId);
	}
});

test("sequential runs of one child each record only their own spend", async () => {
	const { sessionId } = await inMemoryParent("ws-reuse");
	faux.setResponses([fauxAssistantMessage("FIRST"), fauxAssistantMessage("SECOND")]);
	try {
		const child = await scoutChild("ws-reuse", sessionId);
		const first = (await child.runQueued("One.")).details.usage;
		const second = (await child.runQueued("Two.")).details.usage;
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual({
			input: first.input + second.input,
			output: first.output + second.output,
			cacheRead: first.cacheRead + second.cacheRead,
			cacheWrite: first.cacheWrite + second.cacheWrite,
		});
	} finally {
		await removeSession(sessionId);
	}
});

test("a dropped progress write is carried by the run's remainder", async () => {
	const { sessionId, manager } = await inMemoryParent("ws-dropprogress");
	const appendModelUsage = manager.appendModelUsage.bind(manager);
	let failures = 1;
	manager.appendModelUsage = (...args) => {
		if (failures-- > 0) throw new Error("EAGAIN: resource temporarily unavailable");
		return appendModelUsage(...args);
	};
	faux.setResponses([fauxAssistantMessage("DONE")]);
	try {
		const child = await scoutChild("ws-dropprogress", sessionId);
		const { usage } = (await child.runQueued("One.")).details;
		expect(failures).toBe(-1);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
	} finally {
		manager.appendModelUsage = appendModelUsage;
		await removeSession(sessionId);
	}
});

test("a dropped terminal write is recovered by reconciliation, never by the child's next run", async () => {
	const { sessionId, manager } = await inMemoryParent("ws-dropterminal");
	const appendModelUsage = manager.appendModelUsage.bind(manager);
	let failing = true;
	manager.appendModelUsage = (...args) => {
		if (failing) throw new Error("EAGAIN: resource temporarily unavailable");
		return appendModelUsage(...args);
	};
	faux.setResponses([fauxAssistantMessage("FIRST"), fauxAssistantMessage("SECOND")]);
	try {
		const child = await scoutChild("ws-dropterminal", sessionId);
		const first = (await child.runQueued("One.")).details.usage;
		failing = false;
		const second = (await child.runQueued("Two.")).details.usage;
		expect(getSessionStats(sessionId).tokens.input).toBe(second.input);

		await child.dispose();
		await reconcileSessionSubagentUsage("ws-dropterminal", sessionId, () => manager.getEntries());
		expect(getSessionStats(sessionId).tokens.input).toBe(first.input + second.input);
	} finally {
		manager.appendModelUsage = appendModelUsage;
		await removeSession(sessionId);
	}
});

test("a failed deletion after partial progress records only the missing remainder", async () => {
	let reportTrashStarted: () => void = () => {};
	const trashStarted = new Promise<void>((resolve) => {
		reportTrashStarted = resolve;
	});
	let failTrash: () => void = () => {};
	const trashOutcome = new Promise<void>((_resolve, reject) => {
		failTrash = () => reject(new Error("recycle bin unavailable"));
	});
	setTrashImplementationForTests(async () => {
		reportTrashStarted();
		await trashOutcome;
	});
	const { cwd, sessionId, manager, file } = await persistedParent("ws-partialdelete");
	const usageEntries = () => manager.getEntries().filter(isSubagentUsage);
	const { release } = twoStepChildResponses();
	try {
		const child = await scoutChild("ws-partialdelete", sessionId);
		const run = child.runQueued("Two steps.");
		await waitFor(() => usageEntries().length > 0);
		const partial = usageEntries().length;
		const deleting = deleteSession(sessionId, "ws-partialdelete", cwd);
		await trashStarted;
		release();
		const { usage } = (await run).details;
		expect(await subagentUsageOnDisk(file)).toHaveLength(partial);

		failTrash();
		await expect(deleting).rejects.toThrow("recycle bin unavailable");
		await waitFor(() => getSessionStats(sessionId).tokens.input === usage.input);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
	} finally {
		failTrash();
		release();
		setTrashImplementationForTests(undefined);
		await removeSession(sessionId);
	}
});

test("emergency disposal never lets a late subagent record recreate a trashed transcript", async () => {
	const { cwd, sessionId, file } = await persistedParent("ws-emergency");
	setTrashImplementationForTests(async (input) => {
		for (const path of typeof input === "string" ? [input] : input) {
			renameSync(path, `${path}.trashed`);
		}
	});
	const { release, streaming } = gatedChildResponse();
	try {
		const child = await scoutChild("ws-emergency", sessionId);
		const run = child.runQueued("Long background job.");
		await streaming;
		const deleting = deleteSession(sessionId, "ws-emergency", cwd);
		await waitFor(() => !existsSync(file) && liveParentContext(sessionId) === undefined);
		disposeAllSessions();
		release();
		expect((await run).details.usage.input).toBeGreaterThan(0);
		await deleting;
		expect(existsSync(file)).toBe(false);
	} finally {
		release();
		setTrashImplementationForTests(undefined);
	}
});

test("spend dropped by emergency disposal during a close is recovered when the chat reopens", async () => {
	const { cwd, sessionId, file } = await persistedParent("ws-closeemergency");
	const { release, streaming } = gatedChildResponse();
	try {
		const child = await scoutChild("ws-closeemergency", sessionId);
		const run = child.runQueued("Long background job.");
		await streaming;
		const closed = removeSession(sessionId);
		await waitFor(() => liveParentContext(sessionId) === undefined);
		disposeAllSessions();
		release();
		const { usage } = (await run).details;
		await closed;
		expect(usage.input).toBeGreaterThan(0);
		expect(await subagentUsageOnDisk(file)).toEqual([]);

		const reopenedManager = await SessionManager.open(file);
		await createSessionWith(() => reopenedManager, {
			cwd,
			workspaceId: "ws-closeemergency",
		});
		await waitFor(() => getSessionStats(sessionId).tokens.input === usage.input);
	} finally {
		release();
		await removeSession(sessionId);
	}
});

test("owned children remain inspectable before and during their first provider response", async () => {
	const cwd = tmpDir("trdel-prefile-");
	const workspaceId = "ws-prefile";
	const { sessionId } = await createSession({ cwd, workspaceId });
	const service = delegationServiceFor(workspaceId);
	const child = await service.createChild({
		parent: sessionId,
		info: { createdBy: "test" },
		visibility: "hidden",
		session: {},
	});
	expect(existsSync(child.record.sessionFile)).toBe(false);
	expect(readChildTranscript(workspaceId, sessionId, child.sessionId)).toEqual({
		messages: [],
		status: "queued",
	});
	for (const [workspace, parent, id] of [
		["foreign-workspace", sessionId, child.sessionId],
		[workspaceId, "foreign-parent", child.sessionId],
		[workspaceId, sessionId, "unknown-child"],
	] as const)
		expect(() => readChildTranscript(workspace, parent, id)).toThrow("No transcript found");
	const { release, streaming } = gatedChildResponse();
	const run = child.runQueued("Wait for the provider.");
	try {
		await streaming;
		expect(existsSync(child.record.sessionFile)).toBe(true);
		expect(readChildTranscript(workspaceId, sessionId, child.sessionId)).toMatchObject({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Wait for the provider." }],
				},
			],
			status: "running",
		});
	} finally {
		release();
		await run;
	}
	expect(JSON.stringify(readChildTranscript(workspaceId, sessionId, child.sessionId))).toContain(
		"GATED_DONE",
	);
	const canceled = await service.createChild({
		parent: sessionId,
		info: { createdBy: "test" },
		visibility: "hidden",
		session: {},
	});
	await canceled.runQueued("Never sent.", { signal: AbortSignal.abort() });
	expect(existsSync(canceled.record.sessionFile)).toBe(false);
	expect(readChildTranscript(workspaceId, sessionId, canceled.sessionId)).toEqual({
		messages: [],
		status: "aborted",
	});
	await removeSession(sessionId);
	expect(() => readChildTranscript(workspaceId, sessionId, canceled.sessionId)).toThrow(
		"No transcript found",
	);
});

test("deleteSession resolves only after its child cascade settles", async () => {
	const cwd = tmpDir("trdel-await-");
	const { sessionId } = await createSession({ cwd, workspaceId: "ws-await" });
	const service = delegationServiceFor("ws-await");
	const { release, streaming } = gatedChildResponse();
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long gated job.");
	await streaming;

	let deleted = false;
	const done = deleteSession(sessionId, "ws-await", cwd).then(() => {
		deleted = true;
	});
	await waitFor(() => liveParentContext(sessionId) === undefined);
	expect(deleted).toBe(false);

	release();
	await done;
	expect(deleted).toBe(true);
	await run;
});

test("workspace archival awaits in-flight delete transactions before deleting the store", async () => {
	const cwd = tmpDir("trdel-arch-");
	const { sessionId } = await createSession({ cwd, workspaceId: "ws-arch" });
	const service = delegationServiceFor("ws-arch");
	const { release, streaming } = gatedChildResponse();
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long gated job.");
	await streaming;

	let storeAliveAtCascadeEnd: boolean | undefined;
	const unsubscribe = service.onLifecycle((event) => {
		if (event.type === "child-disposed" && event.sessionId === child.sessionId) {
			storeAliveAtCascadeEnd = existsSync(child.record.sessionFile);
		}
	});
	const done = deleteSession(sessionId, "ws-arch", cwd);
	await waitFor(() => liveParentContext(sessionId) === undefined);
	const archived = removeWorkspaceSessions("ws-arch", cwd);
	release();
	await Promise.all([done, archived, run]);
	unsubscribe();
	expect(storeAliveAtCascadeEnd).toBe(true);
});

test("graceful shutdown waits for a background child cascade", async () => {
	const cwd = tmpDir("trdel-shutdown-");
	const { sessionId } = await createSession({ cwd, workspaceId: "ws-shutdown" });
	const service = delegationServiceFor("ws-shutdown");
	const { release, streaming } = gatedChildResponse();
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long background job.");
	await streaming;

	const settled = settleSessionsForShutdown(10_000).then(() => "settled" as const);
	expect(await Promise.race([settled, Promise.resolve("pending" as const)])).toBe("pending");
	release();
	await Promise.all([settled, run]);
	expect(service.findChild(child.sessionId)).toBeUndefined();
	await removeSession(sessionId);
});

test("children follow their parent's retained runtime generation across a flip", async () => {
	const cwdOld = tmpDir("trdel-flip-old-");
	const { sessionId: oldParent } = await createSession({ cwd: cwdOld, workspaceId: "ws-flip" });
	const service = delegationServiceFor("ws-flip");
	const gen2 = await fauxRuntime("fauxg2", "fauxg2");
	let newParent: string | undefined;
	try {
		configurePiRuntime(gen2);
		expect(liveParentContext(oldParent)?.modelRegistry).toBe(baseRuntime.modelRegistry);
		faux.setResponses([fauxAssistantMessage("OLD_GEN_DONE")]);
		const oldChild = await service.createChild({
			parent: oldParent,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "old-parent probe" },
		});
		const oldOutcome = await oldChild.runQueued("Probe old.");
		expect(oldOutcome.status).toBe("completed");
		expect(oldOutcome.details.model).toBe("faux/faux");
		await oldChild.dispose();

		const cwdNew = tmpDir("trdel-flip-new-");
		({ sessionId: newParent } = await createSession({ cwd: cwdNew, workspaceId: "ws-flip" }));
		expect(liveParentContext(newParent)?.modelRegistry).toBe(gen2.modelRegistry);
		faux.setResponses([fauxAssistantMessage("NEW_GEN_DONE")]);
		const newChild = await service.createChild({
			parent: newParent,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "new-parent probe", model: { provider: "fauxg2", id: "fauxg2" } },
		});
		const newOutcome = await newChild.runQueued("Probe new.");
		expect(newOutcome.status).toBe("completed");
		expect(newOutcome.details.model).toBe("fauxg2/fauxg2");
	} finally {
		configurePiRuntime(baseRuntime);
		await removeSession(oldParent);
		if (newParent) await removeSession(newParent);
	}
});

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(Bun.hash.crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

function blankPng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const rows = Buffer.alloc((1 + width * 3) * height);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(rows)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

test("a child without extensions reads images raw and still gets the oversized-image guard", async () => {
	const cwd = tmpDir("trdel-image-");
	writeFileSync(join(cwd, "wide.png"), blankPng(9000, 10));
	const userConfig = join(isolatedAgentDir.dir, "config.yml");
	writeFileSync(userConfig, "images:\n  autoResize: false\n");
	registerFauxProvider(baseRuntime, "faux-claude", fauxModel("claude-faux", ["text", "image"]));
	const { sessionId } = await createSession({ cwd, workspaceId: "ws-image" });
	let toolResult: unknown;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "wide.png" })),
		(context) => {
			toolResult = context.messages.at(-1);
			return fauxAssistantMessage("SEEN");
		},
	]);
	try {
		const child = await delegationServiceFor("ws-image").createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "custom", roleSource: "project" },
			session: { model: { provider: "faux-claude", id: "claude-faux" }, tools: ["read"] },
		});
		expect((await child.runQueued("Read wide.png.")).finalText).toBe("SEEN");
		const seen = JSON.stringify(toolResult);
		expect(seen).toContain("9000\u00d710 exceeds the provider's 8000px image-dimension limit");
		expect(seen).not.toContain("Image omitted");
	} finally {
		rmSync(userConfig, { force: true });
		await removeSession(sessionId);
		baseRuntime.unregisterProvider("faux-claude");
	}
});

async function childSystemPromptIn(workspaceId: string): Promise<string> {
	const cwd = tmpDir(`trdel-${workspaceId}-`);
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(join(cwd, ".omp", "SYSTEM.md"), "PROJECT_SYSTEM_MARKER");
	const { sessionId } = await createSession({ cwd, workspaceId });
	let systemPrompt = "";
	faux.setResponses([
		(context) => {
			systemPrompt = (context.systemPrompt ?? []).join("\n");
			return fauxAssistantMessage("OK");
		},
	]);
	try {
		const child = await delegationServiceFor(workspaceId).createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "test" },
			session: {},
		});
		expect((await child.runQueued("Hi.")).status).toBe("completed");
	} finally {
		await removeSession(sessionId);
	}
	return systemPrompt;
}

test("an untrusted child never takes the project's SYSTEM.md, but the user's and a trusted project's", async () => {
	const userPrompt = join(isolatedAgentDir.dir, "SYSTEM.md");
	writeFileSync(userPrompt, "USER_SYSTEM_MARKER");
	setSkillAdmissionResolver((workspaceId) =>
		admissionContextFor({
			piResourceTrust: workspaceId === "ws-sysprompt-trusted" ? "granted" : "untrusted",
		}),
	);
	try {
		const untrusted = await childSystemPromptIn("ws-sysprompt-untrusted");
		expect(untrusted).toContain("USER_SYSTEM_MARKER");
		expect(untrusted).not.toContain("PROJECT_SYSTEM_MARKER");

		rmSync(userPrompt);
		const bundled = await childSystemPromptIn("ws-sysprompt-bundled");
		expect(bundled).not.toContain("PROJECT_SYSTEM_MARKER");
		expect(bundled.length).toBeGreaterThan(0);

		const trusted = await childSystemPromptIn("ws-sysprompt-trusted");
		expect(trusted).toContain("PROJECT_SYSTEM_MARKER");
	} finally {
		rmSync(userPrompt, { force: true });
		setSkillAdmissionResolver(() => admissionContextFor(undefined));
	}
});

test("the host concurrency resolver binds new services and live-resizes only the refreshed workspace", () => {
	const limits: Record<string, number> = { "ws-limit-a": 2, "ws-limit-b": 5 };
	const resolved: string[] = [];
	setSubagentConcurrencyResolver((workspaceId) => {
		resolved.push(workspaceId);
		return limits[workspaceId] ?? 4;
	});
	try {
		const a = delegationServiceFor("ws-limit-a");
		const b = delegationServiceFor("ws-limit-b");
		expect(resolved).toEqual(["ws-limit-a", "ws-limit-b"]);
		const applied: Array<[string, number]> = [];
		a.setMaxConcurrentPerParent = (slots) => applied.push(["ws-limit-a", slots]);
		b.setMaxConcurrentPerParent = (slots) => applied.push(["ws-limit-b", slots]);

		limits["ws-limit-a"] = 9;
		refreshSubagentConcurrency("ws-limit-a");
		expect(applied).toEqual([["ws-limit-a", 9]]);

		limits["ws-limit-b"] = 1;
		refreshSubagentConcurrency();
		expect(applied).toContainEqual(["ws-limit-a", 9]);
		expect(applied).toContainEqual(["ws-limit-b", 1]);
	} finally {
		setSubagentConcurrencyResolver(() => 4);
	}
});

test("transcript reads accept canonical dotted session ids and reject path-like ids", () => {
	expect(() => readChildTranscript("ws", "parent..session", "child..session")).toThrow(
		"No transcript found",
	);
	expect(() => readChildTranscript("../../etc", "p", "c")).toThrow("Invalid workspaceId");
	expect(() => readChildTranscript("ws", "..", "c")).toThrow("Invalid parentSessionId");
	expect(() => readChildTranscript("ws", "p", "x/../y")).toThrow("Invalid childSessionId");
	expect(() => readChildTranscript("ws", "a\\b", "c")).toThrow("Invalid parentSessionId");
	expect(() => readChildTranscript("", "p", "c")).toThrow("Invalid workspaceId");
});

test("the wire mirrors never drift: completion tag and DelegationRunDetails shape", () => {
	expect(SUBAGENT_COMPLETION_CUSTOM_TYPE).toBe(SUBAGENT_COMPLETION_MESSAGE);
	function pinMirror(core: CoreRunDetails, wire: WireRunDetails): [WireRunDetails, CoreRunDetails] {
		return [core, wire];
	}
	expect(typeof pinMirror).toBe("function");
});
