import { getAgentDir, loadExtensions } from "@oh-my-pi/pi-coding-agent";
import { logger } from "../log";
import { accountAvailableModels, type ModelAvailabilityRuntime } from "./modelAvailability";
import { type LoginOptions, ModelRuntime, registryProviderConfig } from "./modelRuntime";

const log = logger("agent");

export interface PiRuntimeGeneration {
	readonly id: number;
	readonly runtime: ModelRuntime;
	readonly providerStatusIds: ReadonlySet<string>;
	readonly providerStatusNames: ReadonlyMap<string, string>;
	readonly opaqueProviderIds: ReadonlySet<string>;
	readonly additionalExtensionPaths: readonly string[];
	readonly excludedSessionExtensionPaths: readonly string[];
}

export type PreparePiRuntimeGenerationResult =
	| { outcome: "prepared"; generation: PiRuntimeGeneration }
	| { outcome: "failed"; reason: "candidate-failed" };

export type PiRuntimeGenerationInitializer = (runtime: ModelRuntime) => void | Promise<void>;

export const piLoginOptions: LoginOptions = {};

let nextGenerationId = 1;
let activeGeneration: Promise<PiRuntimeGeneration> | null = null;
let configuredExtensionPaths: readonly string[] = [];
let configuredSessionExtensionExclusions: readonly string[] = [];
interface PreparedRuntime {
	runtime: ModelRuntime;
	providerStatusIds: ReadonlySet<string>;
	providerStatusNames: ReadonlyMap<string, string>;
	opaqueProviderIds: ReadonlySet<string>;
}
let runtimeFactory: (additionalExtensionPaths: readonly string[]) => Promise<PreparedRuntime> =
	createRuntimeWithExtensions;
let generationInitializer: PiRuntimeGenerationInitializer = () => {};

function captureProviderStatus(runtime: ModelRuntime): {
	ids: ReadonlySet<string>;
	names: ReadonlyMap<string, string>;
} {
	const providers = runtime.getProviders();
	return {
		ids: new Set(providers.map((provider) => provider.id)),
		names: new Map(providers.map((provider) => [provider.id, provider.name])),
	};
}

export function configurePiRuntime(rt: ModelRuntime | null): void {
	configuredExtensionPaths = [];
	configuredSessionExtensionExclusions = [];
	if (!rt) {
		activeGeneration = null;
		return;
	}
	const providerStatus = captureProviderStatus(rt);
	activeGeneration = Promise.resolve({
		id: nextGenerationId++,
		runtime: rt,
		providerStatusIds: providerStatus.ids,
		providerStatusNames: providerStatus.names,
		opaqueProviderIds: new Set<string>(),
		additionalExtensionPaths: [],
		excludedSessionExtensionPaths: [],
	});
}

export function configurePiRuntimeFactory(
	factory?: (additionalExtensionPaths: readonly string[]) => Promise<ModelRuntime>,
): void {
	runtimeFactory = factory
		? async (additionalExtensionPaths) => {
				const runtime = await factory(additionalExtensionPaths);
				await generationInitializer(runtime);
				const providerStatus = captureProviderStatus(runtime);
				return {
					runtime,
					providerStatusIds: providerStatus.ids,
					providerStatusNames: providerStatus.names,
					opaqueProviderIds: new Set<string>(),
				};
			}
		: createRuntimeWithExtensions;
}

export function configurePiRuntimeGenerationInitializer(
	initializer?: PiRuntimeGenerationInitializer,
): void {
	if (activeGeneration) throw new Error("PI runtime already initialized");
	generationInitializer = initializer ?? (() => {});
}

export function configurePiRuntimeSessionExtensionExclusions(paths: readonly string[]): void {
	if (activeGeneration) throw new Error("PI runtime already initialized");
	configuredSessionExtensionExclusions = [...new Set(paths)];
}

async function loadExtensionProviders(
	runtime: ModelRuntime,
	additionalExtensionPaths: readonly string[],
): Promise<void> {
	if (additionalExtensionPaths.length === 0) return;
	const agentDir = getAgentDir();
	const result = await loadExtensions([...additionalExtensionPaths], agentDir);
	if (result.errors.length > 0) {
		for (const failure of result.errors)
			log.warn(`extension ${failure.path} failed to load: ${failure.error}`);
		throw new Error("PI runtime extension loading failed");
	}
	for (const registration of result.runtime.pendingProviderRegistrations)
		runtime.registerProvider(registration.name, registryProviderConfig(registration.config));
	result.runtime.pendingProviderRegistrations = [];
	await runtime.modelRegistry.refreshRuntimeProviders("offline");
}

async function createRuntimeWithExtensions(
	additionalExtensionPaths: readonly string[],
): Promise<PreparedRuntime> {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	await generationInitializer(runtime);
	const providerStatus = captureProviderStatus(runtime);
	const priorRegistrations = new Map(
		runtime.getRegisteredProviderIds().map((id) => [
			id,
			{
				provider: runtime.getRegisteredNativeProvider(id),
				registration: runtime.getRegisteredProviderConfig(id),
			},
		]),
	);
	await loadExtensionProviders(runtime, additionalExtensionPaths);
	const postExtensionProviderStatus = captureProviderStatus(runtime);
	const opaqueProviderIds = new Set(
		additionalExtensionPaths.length > 0
			? [
					...[...postExtensionProviderStatus.ids].filter((id) => !providerStatus.ids.has(id)),
					...runtime.getRegisteredProviderIds().filter((id) => {
						const prior = priorRegistrations.get(id);
						return (
							!prior ||
							prior.provider !== runtime.getRegisteredNativeProvider(id) ||
							prior.registration !== runtime.getRegisteredProviderConfig(id)
						);
					}),
				]
			: [],
	);
	return {
		runtime,
		providerStatusIds: providerStatus.ids,
		providerStatusNames: providerStatus.names,
		opaqueProviderIds,
	};
}

async function createGeneration(paths: readonly string[]): Promise<PiRuntimeGeneration> {
	const additionalExtensionPaths = [...new Set(paths)];
	const excludedSessionExtensionPaths = [...configuredSessionExtensionExclusions];
	const prepared = await runtimeFactory(additionalExtensionPaths);
	return {
		id: nextGenerationId++,
		runtime: prepared.runtime,
		providerStatusIds: prepared.providerStatusIds,
		providerStatusNames: prepared.providerStatusNames,
		opaqueProviderIds: prepared.opaqueProviderIds,
		additionalExtensionPaths,
		excludedSessionExtensionPaths,
	};
}

export function getPiRuntimeGeneration(): Promise<PiRuntimeGeneration> {
	if (!activeGeneration) {
		const created = createGeneration(configuredExtensionPaths);
		activeGeneration = created;
		created.catch(() => {
			if (activeGeneration === created) activeGeneration = null;
		});
	}
	return activeGeneration;
}

export async function getPiRuntime(): Promise<ModelRuntime> {
	return (await getPiRuntimeGeneration()).runtime;
}

export async function preparePiRuntimeGeneration(
	additionalExtensionPaths: readonly string[],
): Promise<PreparePiRuntimeGenerationResult> {
	try {
		return { outcome: "prepared", generation: await createGeneration(additionalExtensionPaths) };
	} catch {
		return { outcome: "failed", reason: "candidate-failed" };
	}
}

export function activatePiRuntimeGeneration(generation: PiRuntimeGeneration): void {
	configuredExtensionPaths = generation.additionalExtensionPaths;
	configuredSessionExtensionExclusions = generation.excludedSessionExtensionPaths;
	activeGeneration = Promise.resolve(generation);
}

export type AvailableModelsRuntime = ModelAvailabilityRuntime;

export function settledAvailableModels(
	runtime: AvailableModelsRuntime,
): ReturnType<ModelRuntime["getAvailableSnapshot"]> {
	return accountAvailableModels(runtime);
}

export type CatalogRefreshRuntime = Pick<ModelRuntime, "refresh">;

export interface CatalogRefreshOutcome {
	completed: boolean;
}

const inflightCatalogRefresh = new WeakMap<
	CatalogRefreshRuntime,
	{ task: Promise<void>; force: boolean }
>();

const CATALOG_REFRESH_TIMEOUT_MS = 15_000;

export function refreshCatalogs(
	runtime: CatalogRefreshRuntime,
	{ force = false }: { force?: boolean } = {},
): Promise<CatalogRefreshOutcome> {
	if (process.env.PI_OFFLINE) return Promise.resolve({ completed: true });
	const existing = inflightCatalogRefresh.get(runtime);
	if (existing && (existing.force || !force)) return withDeadline(existing.task);
	const started = existing
		? existing.task.then(() => runCatalogRefresh(runtime, force))
		: runCatalogRefresh(runtime, force);
	const task: Promise<void> = started.finally(() => {
		if (inflightCatalogRefresh.get(runtime)?.task === task) {
			inflightCatalogRefresh.delete(runtime);
		}
	});
	inflightCatalogRefresh.set(runtime, { task, force });
	return withDeadline(task);
}

function withDeadline(task: Promise<void>): Promise<CatalogRefreshOutcome> {
	return new Promise<CatalogRefreshOutcome>((resolve) => {
		const timer = setTimeout(() => {
			log.warn(
				`model catalog refresh exceeded ${CATALOG_REFRESH_TIMEOUT_MS}ms; serving cached catalogs`,
			);
			resolve({ completed: false });
		}, CATALOG_REFRESH_TIMEOUT_MS);
		timer.unref?.();
		void task.then(() => {
			clearTimeout(timer);
			resolve({ completed: true });
		});
	});
}

function runCatalogRefresh(runtime: CatalogRefreshRuntime, force: boolean): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_REFRESH_TIMEOUT_MS);
	timer.unref?.();
	return runtime
		.refresh({ allowNetwork: true, force, signal: controller.signal })
		.then((result) => {
			if (result.aborted) {
				log.warn(
					`model catalog refresh timed out after ${CATALOG_REFRESH_TIMEOUT_MS}ms; serving cached catalogs`,
				);
			} else if (result.errors.size > 0) {
				log.warn(`model catalog refresh: ${result.errors.size} provider(s) failed`);
			}
		})
		.catch(() => {
			log.warn("model catalog refresh failed");
		})
		.finally(() => clearTimeout(timer));
}

export function refreshCatalogsDetached(runtime: CatalogRefreshRuntime): void {
	void refreshCatalogs(runtime);
}
