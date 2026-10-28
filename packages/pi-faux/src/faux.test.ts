import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import {
	createAgentSession,
	type ExtensionAPI,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
	createFauxCore,
	createFauxModelRegistry,
	fauxAssistantMessage,
	fauxProvider,
	fauxThinking,
	fauxToolCall,
	type IsolatedAgentDir,
	isolateAgentDir,
	registerFaux,
} from "../index";

const root = mkdtempSync(join(tmpdir(), "pi-faux-"));
let agentDirIsolation: IsolatedAgentDir | undefined;

beforeAll(() => {
	agentDirIsolation = isolateAgentDir(join(root, "agent"));
});

afterAll(() => {
	agentDirIsolation?.restore();
	rmSync(root, { recursive: true, force: true });
});

async function collect(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("a queued response streams as ordered deltas that rebuild the message", async () => {
	const faux = createFauxCore({ provider: "faux-stream", tokenSize: { min: 1, max: 1 } });
	faux.setResponses([
		fauxAssistantMessage([
			fauxThinking("weighing it"),
			{ type: "text", text: "the answer is forty-two" },
		]),
	]);
	const stream = faux.stream(faux.getModel(), { messages: [] });
	const events = await collect(stream);
	const final = await stream.result();
	expect(events[0]?.type).toBe("start");
	expect(events.at(-1)?.type).toBe("done");
	const text = events
		.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []))
		.join("");
	expect(text).toBe("the answer is forty-two");
	expect(events.filter((event) => event.type === "text_delta").length).toBeGreaterThan(1);
	expect(final.provider).toBe("faux-stream");
	expect(final.usage.output).toBeGreaterThan(0);
	expect(faux.state.callCount).toBe(1);
});

test("an exhausted queue answers with an error message rather than throwing", async () => {
	const faux = createFauxCore({ provider: "faux-empty" });
	const stream = faux.stream(faux.getModel(), { messages: [] });
	const final = await stream.result();
	expect(final.stopReason).toBe("error");
	expect(final.errorMessage).toBe("No more faux responses queued");
});

test("a factory step sees the request context and provider state", async () => {
	const faux = createFauxCore({ provider: "faux-factory" });
	faux.setResponses([
		(context, _options, state) =>
			fauxAssistantMessage(`saw ${context.messages.length} message(s) on call ${state.callCount}`),
	]);
	const final = await faux
		.stream(faux.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] })
		.result();
	expect(final.content).toEqual([{ type: "text", text: "saw 1 message(s) on call 1" }]);
	expect(faux.getPendingResponseCount()).toBe(0);
});

test("an aborted request ends with an aborted error", async () => {
	const faux = createFauxCore({ provider: "faux-abort", tokensPerSecond: 1 });
	faux.setResponses([fauxAssistantMessage("a long reply that takes a while to stream")]);
	const controller = new AbortController();
	const stream = faux.stream(faux.getModel(), { messages: [] }, { signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	const final = await stream.result();
	expect(final.stopReason).toBe("aborted");
});

test("a registered faux provider drives a full agent session with a tool round trip", async () => {
	const settings = Settings.isolated({});
	const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
	const faux = fauxProvider({ provider: "faux-session" });
	const model = registerFaux(modelRegistry, faux);
	let echoed: string | undefined;
	const echoExtension = (pi: ExtensionAPI): void => {
		const parameters = pi.zod.object({ value: pi.zod.string() });
		pi.registerTool({
			name: "echo",
			label: "Echo",
			description: "Echo a value",
			parameters,
			async execute(_id, params) {
				echoed = params.value;
				return { content: [{ type: "text", text: `echo:${params.value}` }] };
			},
		});
	};
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("echo", { value: "ping" }), { stopReason: "toolUse" }),
		(context) => {
			const last = context.messages.at(-1);
			const result = last?.role === "toolResult" ? last.content : [];
			return fauxAssistantMessage(`done after ${JSON.stringify(result)}`);
		},
	]);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		settings,
		authStorage,
		modelRegistry,
		model,
		sessionManager: SessionManager.inMemory(root),
		extensions: [echoExtension],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
	});
	try {
		const deltas: string[] = [];
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
				deltas.push(event.assistantMessageEvent.delta);
		});
		await session.prompt("echo ping");
		await session.waitForIdle();
		expect(echoed).toBe("ping");
		expect(deltas.join("")).toContain("echo:ping");
		expect(faux.state.callCount).toBe(2);
	} finally {
		await session.dispose();
	}
});
