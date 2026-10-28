import {
	type ExtensionContext,
	type ExtensionFactory,
	type TurnEndEvent,
	z,
} from "@oh-my-pi/pi-coding-agent";
import { tail } from "./output";
import { createBackgroundCommands } from "./service";
import { standaloneContext } from "./shell-context";
import type {
	BackgroundCommandCompletion,
	BackgroundCommandFlush,
	BackgroundCommandSnapshot,
	BackgroundCommands,
} from "./types";

export const BACKGROUND_COMMAND_COMPLETION_MESSAGE = "background-command-completion";

export type CompletionDelivery = "wake" | "run" | "appended";

type DeliveryMode = { idle: true } | { idle: false; runContinues: boolean };

export interface BackgroundCommandsExtensionOptions {
	service?: BackgroundCommands;
	canDeliverCompletion?(): boolean;
}

export type BackgroundCommandInput =
	| { action: "start"; command: string; name?: string; timeout?: number }
	| { action: "list" }
	| { action: "output" | "stop"; id: string };

const parameters = z
	.object({
		action: z.enum(["start", "list", "output", "stop"]),
		command: z
			.string()
			.min(1)
			.max(65536)
			.describe("Foreground shell command, for start only")
			.optional(),
		name: z.string().max(200).describe("Display name, for start only").optional(),
		timeout: z
			.number()
			.positive()
			.max(2147483.647)
			.describe("Timeout in seconds, for start only; no default")
			.optional(),
		id: z
			.string()
			.describe("Opaque command id returned by start, for output or stop only")
			.optional(),
	})
	.passthrough();

const description = [
	"Explicitly start a noninteractive background command, list this session's commands, read output, or stop one command by id. Output is a replacement snapshot of the last 2000 lines / 50 KiB, not an archive. Only start accepts command, name and timeout (seconds). At most 8 commands may be active; the latest 20 finished records are retained. Stop requests cancellation; stopping is not yet terminal.",
	"Use background_command only for explicitly background work; ordinary bash behavior is unchanged.",
	"Keep background_command shell commands foreground: do not detach with &, nohup, disown, daemonization, or similar escapes. Managed commands have no stdin or PTY.",
	"A finished background_command is reported to you automatically, before your next step while you work or as a new turn when you are idle; do not poll or sleep to wait, end your turn instead. Use output when recent logs are needed. Stop cancels without waking the parent.",
].join("\n");

function assertInput(input: unknown): asserts input is BackgroundCommandInput {
	if (!input || typeof input !== "object" || !("action" in input))
		throw new Error("A background command action is required");
	let allowed: string[];
	switch (input.action) {
		case "start":
			allowed = ["action", "command", "name", "timeout"];
			if (!("command" in input) || typeof input.command !== "string")
				throw new Error("start requires command");
			if ("name" in input && typeof input.name !== "string")
				throw new Error("name must be a string");
			if ("timeout" in input && typeof input.timeout !== "number")
				throw new Error("timeout must be seconds");
			break;
		case "list":
			allowed = ["action"];
			break;
		case "output":
		case "stop":
			allowed = ["action", "id"];
			if (!("id" in input) || typeof input.id !== "string" || !input.id)
				throw new Error("output and stop require a command id");
			break;
		default:
			throw new Error("Unknown background command action");
	}
	if (Object.keys(input).some((key) => !allowed.includes(key)))
		throw new Error("Unsupported inputs for this background command action");
}

function summary(snapshot: BackgroundCommandSnapshot) {
	const { command: _command, ...result } = snapshot;
	return result;
}

function statusText(snapshot: BackgroundCommandSnapshot): string {
	return `${snapshot.id} (${snapshot.name}): ${snapshot.status}`;
}

function terminalText(snapshot: BackgroundCommandSnapshot): string {
	const exit =
		snapshot.exitCode === undefined || snapshot.exitCode === null
			? ""
			: `, exit code ${snapshot.exitCode}`;
	return `${statusText(snapshot)}${exit}${snapshot.errorMessage ? `\n${snapshot.errorMessage}` : ""}`;
}

const heldAtStopByService = new WeakMap<BackgroundCommands, Set<string>>();

function heldAtStopFor(service: BackgroundCommands): Set<string> {
	let held = heldAtStopByService.get(service);
	if (!held) {
		held = new Set();
		heldAtStopByService.set(service, held);
	}
	return held;
}

function deliveryOf(mode: DeliveryMode, batchWakes: boolean, index: number): CompletionDelivery {
	if (mode.idle) return !batchWakes ? "appended" : index === 0 ? "wake" : "run";
	return "run";
}

function eligibleTurn(event: TurnEndEvent): { runContinues: boolean } | undefined {
	const message = event.message;
	if (message.role !== "assistant") return undefined;
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return undefined;
	return {
		runContinues:
			message.stopReason === "toolUse" ||
			message.content.some((block) => block.type === "toolCall"),
	};
}

export function createBackgroundCommandsExtension(
	options: BackgroundCommandsExtensionOptions = {},
): ExtensionFactory {
	return (pi) => {
		let service = options.service;
		let latestContext: ExtensionContext | undefined;
		let sessionContext: ExtensionContext | undefined;
		let shuttingDown = false;
		let unbind: (() => void) | undefined;
		let turnEnd: { runContinues: boolean } | undefined;
		let boundary: { runContinues: boolean } | undefined;
		let running = false;
		let runAborted = false;
		let flushScheduled = false;
		const batch = { calls: new Set<string>(), executing: false };

		const parentIdle = () => {
			try {
				return sessionContext?.isIdle() ?? false;
			} catch {
				return false;
			}
		};
		const modeFor = (flush: BackgroundCommandFlush): DeliveryMode | undefined => {
			if (boundary) return { idle: false, runContinues: boundary.runContinues };
			if (parentIdle()) return flushScheduled ? undefined : { idle: true };
			if (flush.atTurnEnd && turnEnd) return { idle: false, ...turnEnd };
			return undefined;
		};
		const wakes = ({ snapshot }: BackgroundCommandCompletion) =>
			snapshot.status !== "stopped" && !(service && heldAtStopFor(service).has(snapshot.id));
		const scheduleFlush = (delayMs = 0) => {
			if (flushScheduled || shuttingDown) return;
			flushScheduled = true;
			setTimeout(() => {
				flushScheduled = false;
				if (shuttingDown) return;
				if (!running && !parentIdle()) {
					scheduleFlush(10);
					return;
				}
				service?.flushCompletions();
			}, delayMs);
		};

		const releaseAt = (step: { runContinues: boolean }) => {
			boundary = step;
			try {
				service?.flushCompletions();
			} finally {
				boundary = undefined;
			}
		};

		pi.on("tool_call", (event) => {
			if (batch.executing) {
				batch.calls.clear();
				batch.executing = false;
			}
			batch.calls.add(event.toolCallId);
			return undefined;
		});
		pi.on("tool_result", (event) => {
			if (!batch.calls.delete(event.toolCallId)) return undefined;
			batch.executing = true;
			if (batch.calls.size === 0) releaseAt({ runContinues: true });
			return undefined;
		});
		pi.on("turn_end", (event) => {
			const message = event.message;
			if (message.role === "assistant" && message.stopReason === "aborted") runAborted = true;
			turnEnd = eligibleTurn(event);
			if (turnEnd) releaseAt(turnEnd);
		});
		pi.on("turn_start", () => {
			turnEnd = undefined;
		});
		pi.on("agent_start", () => {
			running = true;
			runAborted = false;
		});
		pi.on("agent_end", (event) => {
			turnEnd = undefined;
			if (event.willContinue === true) return;
			running = false;
			if (runAborted && service) {
				const held = heldAtStopFor(service);
				for (const snapshot of service.list()) {
					if (snapshot.finishedAt !== undefined) held.add(snapshot.id);
				}
				for (const id of held) if (!service.find(id)) held.delete(id);
			}
			runAborted = false;
			scheduleFlush();
		});
		pi.on("before_agent_start", (event) => {
			if (event.reason === "prompt" && service) heldAtStopFor(service).clear();
		});
		pi.on("session_compact", () => scheduleFlush());
		pi.on("auto_compaction_end", () => scheduleFlush());
		pi.on("session_tree", () => scheduleFlush());

		pi.registerTool({
			name: "background_command",
			label: "Background command",
			description,
			parameters,
			loadMode: "essential",
			async execute(_toolCallId, params, _signal, _onUpdate, currentContext) {
				if (shuttingDown || !service)
					throw new Error("Background commands session is shutting down");
				if (currentContext.sessionManager.getSessionId() !== service.sessionId)
					throw new Error("Background commands belong to a different session");
				latestContext = currentContext;
				assertInput(params);
				if (params.action === "start") {
					const handle = service.start(params);
					return {
						content: [
							{ type: "text", text: `Accepted background command ${statusText(handle.snapshot)}` },
						],
						details: { snapshot: handle.snapshot },
					};
				}
				if (params.action === "list") {
					const snapshots = service.list();
					return {
						content: [
							{
								type: "text",
								text:
									snapshots.map(statusText).join("\n") || "No background commands in this session.",
							},
						],
						details: { commands: snapshots.map(summary) },
					};
				}
				const handle = service.find(params.id);
				if (!handle)
					throw new Error(
						"Background command unavailable in this session (unknown, evicted, or lost on host restart)",
					);
				if (params.action === "stop") {
					const snapshot = handle.stop();
					return {
						content: [{ type: "text", text: `Stop requested; ${statusText(snapshot)}` }],
						details: { snapshot },
					};
				}
				const output = handle.output;
				if (!output) throw new Error("Background command output unavailable");
				const snapshot = handle.snapshot;
				const finished = snapshot.finishedAt !== undefined;
				if (finished) handle.claimCompletion();
				return {
					content: [
						{
							type: "text",
							text: `${finished ? terminalText(snapshot) : statusText(snapshot)}\n\n${output.truncated ? "[Output truncated; retained tail only.]\n" : ""}${output.text || "(no output)"}`,
						},
					],
					details: { snapshot, output },
				};
			},
		});

		pi.on("session_start", (_event, ctx) => {
			latestContext = ctx;
			sessionContext = ctx;
			shuttingDown = false;
			service ??= createBackgroundCommands({
				sessionId: ctx.sessionManager.getSessionId(),
				getContext() {
					if (!latestContext) throw new Error("Session context is unavailable");
					return standaloneContext(latestContext, pi);
				},
			});
			if (service.sessionId !== ctx.sessionManager.getSessionId())
				throw new Error("Background commands belong to a different session");

			unbind?.();
			unbind = service.bindCompletion({
				canDeliverCompletion: (flush) =>
					!shuttingDown &&
					options.canDeliverCompletion?.() !== false &&
					modeFor(flush) !== undefined,
				deliver(batch, flush) {
					const mode = modeFor(flush);
					if (!mode) return [];
					const batchWakes = batch.some(wakes);
					if (!mode.idle && !mode.runContinues && !batchWakes) return [];
					const carrier = mode.idle ? batch.findLast(wakes) : undefined;
					const ordered = carrier ? [...batch.filter((c) => c !== carrier), carrier] : batch;
					const accepted: BackgroundCommandCompletion[] = [];
					for (const [index, completion] of ordered.entries()) {
						const { snapshot, output } = completion;
						const excerpt = tail(output.text, 4096, 40);
						const truncated = output.truncated || excerpt.truncated;
						const status = snapshot.status === "stopped" ? "Cancelled" : "Finished";
						const diagnostic = snapshot.errorMessage ? `\n${snapshot.errorMessage}` : "";
						try {
							pi.sendMessage(
								{
									customType: BACKGROUND_COMMAND_COMPLETION_MESSAGE,
									display: true,
									content: `${status} background command ${statusText(snapshot)}${diagnostic}\n\n${excerpt.text || "(no output)"}${truncated ? "\n[Excerpt truncated; use background_command output for the retained tail.]" : ""}`,
									details: {
										...summary(snapshot),
										output: { text: excerpt.text, truncated },
										delivery: deliveryOf(mode, batchWakes, index),
									},
								},
								mode.idle ? { triggerTurn: completion === carrier } : { deliverAs: "aside" },
							);
						} catch {
							break;
						}
						accepted.push(completion);
					}
					return accepted;
				},
			});
		});

		pi.on("session_shutdown", async () => {
			shuttingDown = true;
			unbind?.();
			unbind = undefined;
			if (!options.service) {
				await service?.dispose();
				service = undefined;
			}
			latestContext = undefined;
		});
	};
}
