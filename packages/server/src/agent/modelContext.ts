import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import {
	isModelContextWindow,
	isSharedModelContextTarget,
	MODEL_CONTEXT_WINDOW_LIMITS,
	type ModelContextSetting,
	type ModelContextTarget,
} from "@thinkrail/contracts";
import { type Document, isMap, parseDocument } from "yaml";
import { usePiRuntime } from "./agentSessionManager";
import type { ModelRuntime } from "./modelRuntime";
import { type AvailableModelsRuntime, settledAvailableModels } from "./piRuntime";

const OPENAI_RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const EMPTY_CONFIG = "providers: {}\n";

let publishContextChange: (() => void) | null = null;

export function setModelContextPublisher(publisher: (() => void) | null): void {
	publishContextChange = publisher;
}

function modelsFile(runtime: ModelRuntime): string {
	if (runtime.modelsConfigPath === undefined)
		throw new Error("This runtime ignores the local model configuration.");
	return ModelsConfigFile.relocate(runtime.modelsConfigPath).path();
}

function saveFailure(path: string): Error {
	return new Error(
		`Couldn't save ${basename(path)}. Check the file and its permissions, then retry.`,
	);
}

function readSource(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Couldn't read ${basename(path)}. Fix the file and retry.`);
	}
}

function parseConfig(path: string, source: string | undefined): Document | undefined {
	if (source === undefined) return undefined;
	const document = parseDocument(source.replace(/^\uFEFF/, ""));
	if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents)))
		throw new Error(`${basename(path)} isn't valid YAML. Fix the file and retry.`);
	return document;
}

function overridePath(model: Pick<ModelContextSetting, "provider" | "id">): string[] {
	return ["providers", model.provider, "modelOverrides", model.id, "contextWindow"];
}

function listSettings(
	runtime: AvailableModelsRuntime,
	config: Document | undefined,
): ModelContextSetting[] {
	return settledAvailableModels(runtime).flatMap((model) => {
		if (!OPENAI_RESPONSES_APIS.has(model.api) || model.contextWindow === null) return [];
		const value: unknown = config?.getIn(overridePath(model));
		const override = typeof value === "number" ? value : null;
		if (override === null && model.contextWindow !== MODEL_CONTEXT_WINDOW_LIMITS.min) return [];
		return [
			{
				provider: model.provider,
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				override,
			},
		];
	});
}

function patch(document: Document, path: string[], contextWindow: number | null): void {
	if (contextWindow !== null) {
		document.setIn(path, contextWindow);
		return;
	}
	let current = path;
	while (current.length > 1) {
		document.deleteIn(current);
		const parent = current.slice(0, -1);
		const node = document.getIn(parent, true);
		if (!isMap(node) || node.items.length > 0) break;
		current = parent;
	}
}

function resolveModelsFile(path: string): string {
	try {
		return realpathSync(path);
	} catch {}
	const seen = new Set<string>();
	let current = path;
	while (!seen.has(current)) {
		seen.add(current);
		try {
			current = resolve(dirname(current), readlinkSync(current));
		} catch {
			return current;
		}
	}
	throw saveFailure(path);
}

function writeModelsFile(path: string, source: string): void {
	const target = resolveModelsFile(path);
	let existing: Stats | undefined;
	try {
		existing = statSync(target);
	} catch {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	}
	const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
	try {
		if (existing) accessSync(target, constants.W_OK);
		writeFileSync(temp, source, { mode: existing ? existing.mode & 0o777 : 0o600 });
		renameSync(temp, target);
	} catch {
		rmSync(temp, { force: true });
		throw saveFailure(path);
	}
}

export function listModelContextSettings(): Promise<ModelContextSetting[]> {
	return usePiRuntime(async (runtime) => {
		await runtime.refresh({ allowNetwork: false });
		const path = modelsFile(runtime);
		return listSettings(runtime, parseConfig(path, readSource(path)));
	});
}

let saving: Promise<unknown> = Promise.resolve();

export function setModelContextWindow(
	target: ModelContextTarget,
	contextWindow: number | null,
): Promise<ModelContextSetting[]> {
	if (contextWindow !== null && !isModelContextWindow(contextWindow)) {
		return Promise.reject(
			new Error(
				`Context window must be a whole number between ${MODEL_CONTEXT_WINDOW_LIMITS.min.toLocaleString("en-US")} and ${MODEL_CONTEXT_WINDOW_LIMITS.max.toLocaleString("en-US")} tokens`,
			),
		);
	}
	const run = saving.catch(() => undefined).then(() => save(target, contextWindow));
	saving = run;
	return run;
}

function save(
	target: ModelContextTarget,
	contextWindow: number | null,
): Promise<ModelContextSetting[]> {
	return usePiRuntime(async (runtime) => {
		await runtime.refresh({ allowNetwork: false });
		const path = modelsFile(runtime);
		const source = readSource(path);
		const document = parseConfig(path, source) ?? parseDocument(EMPTY_CONFIG);
		const settings = listSettings(runtime, document);
		const targets =
			target === "available"
				? settings.filter(isSharedModelContextTarget)
				: settings.filter((model) => model.provider === target.provider && model.id === target.id);
		if (targets.length === 0) throw new Error("Unknown, unavailable or ineligible context target");
		const bom = source?.startsWith("\uFEFF") ? "\uFEFF" : "";
		const before = document.toString();
		for (const model of targets) patch(document, overridePath(model), contextWindow);
		const next = document.toString();
		if (source === undefined ? next !== EMPTY_CONFIG : next !== before) {
			writeModelsFile(path, bom + next);
			await runtime.refresh({ allowNetwork: false });
			publishContextChange?.();
		}
		return listSettings(runtime, document);
	});
}
