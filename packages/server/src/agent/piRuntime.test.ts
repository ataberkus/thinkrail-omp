import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuthStorage, Settings } from "@oh-my-pi/pi-coding-agent";
import { isolateAgentDir } from "pi-faux";
import { buildSessionResources } from "./extensions";
import type { ModelsRefreshOptions, ModelsRefreshResult } from "./modelRuntime";
import {
	type CatalogRefreshRuntime,
	configurePiRuntime,
	configurePiRuntimeGenerationInitializer,
	getPiRuntime,
	piLoginOptions,
	preparePiRuntimeGeneration,
	refreshCatalogs,
	refreshCatalogsDetached,
} from "./piRuntime";

let priorOffline: string | undefined;
beforeEach(() => {
	priorOffline = process.env.PI_OFFLINE;
	delete process.env.PI_OFFLINE;
});
afterEach(() => {
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
});

async function isolatedRuntime() {
	const agentDir = mkdtempSync(join(tmpdir(), "trpi-runtime-"));
	const isolated = isolateAgentDir(agentDir);
	configurePiRuntime(null);
	try {
		return { runtime: await getPiRuntime(), agentDir };
	} finally {
		isolated.restore();
	}
}

const trustedAdmission = () => ({
	trusted: true,
	piResourceTrusted: true,
	acknowledged: [],
	disabled: [],
	disabledGroups: [],
	overrides: {},
});

function cleanup(agentDir: string): void {
	configurePiRuntime(null);
	rmSync(agentDir, { recursive: true, force: true });
}

test("session resources exclude an opaque generation artifact but keep other discovered extensions", async () => {
	const root = mkdtempSync(join(tmpdir(), "trpi-session-extension-filter-"));
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	const centralPath = join(extensionsDir, "jetbrains-central.ts");
	const siblingPath = join(extensionsDir, "sibling.ts");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(centralPath, "export default function excluded() {}\n");
	writeFileSync(siblingPath, "export default function sibling() {}\n");
	const isolated = isolateAgentDir(agentDir);
	try {
		const resources = await buildSessionResources({
			cwd: root,
			settings: Settings.isolated(),
			projectTrusted: true,
			getAdmission: trustedAdmission,
			excludedExtensionPaths: [centralPath],
		});
		expect(resources.preloadedExtensionPaths).toContain(siblingPath);
		expect(resources.preloadedExtensionPaths).not.toContain(centralPath);
		expect(resources.disableExtensionDiscovery).toBe(true);
	} finally {
		isolated.restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an excluding session build re-resolves its extension set every time and honours disabledExtensions settings", async () => {
	const root = mkdtempSync(join(tmpdir(), "trpi-session-extension-reload-"));
	const agentDir = join(root, "agent");
	const extensionsDir = join(agentDir, "extensions");
	const centralPath = join(extensionsDir, "jetbrains-central.ts");
	const probePath = join(extensionsDir, "probe.ts");
	const latePath = join(extensionsDir, "late.ts");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(centralPath, "export default function excluded() {}\n");
	writeFileSync(probePath, "export default function probe() {}\n");
	const isolated = isolateAgentDir(agentDir);
	const build = (disabledExtensions: string[]) =>
		buildSessionResources({
			cwd: root,
			settings: Settings.isolated({ disabledExtensions }),
			projectTrusted: true,
			getAdmission: trustedAdmission,
			excludedExtensionPaths: [centralPath],
		});
	try {
		const first = await build(["extension-module:probe"]);
		expect(first.preloadedExtensionPaths).not.toContain(probePath);
		expect(first.preloadedExtensionPaths).not.toContain(latePath);

		writeFileSync(latePath, "export default function late() {}\n");
		const second = await build([]);
		expect(second.preloadedExtensionPaths).toContain(latePath);
		expect(second.preloadedExtensionPaths).toContain(probePath);
		expect(second.preloadedExtensionPaths).not.toContain(centralPath);
	} finally {
		isolated.restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the process-local initializer applies to every fresh runtime generation", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trpi-generation-initializer-"));
	const isolated = isolateAgentDir(agentDir);
	configurePiRuntime(null);
	let calls = 0;
	configurePiRuntimeGenerationInitializer((runtime) => {
		calls += 1;
		runtime.registerProvider("generation-initializer-probe", { name: "Generation initializer" });
	});
	try {
		const first = await preparePiRuntimeGeneration([]);
		const second = await preparePiRuntimeGeneration([]);
		expect(first.outcome).toBe("prepared");
		expect(second.outcome).toBe("prepared");
		if (first.outcome !== "prepared" || second.outcome !== "prepared") return;
		expect(first.generation.runtime.getRegisteredProviderIds()).toContain(
			"generation-initializer-probe",
		);
		expect(first.generation.providerStatusIds).toContain("generation-initializer-probe");
		expect(first.generation.opaqueProviderIds.size).toBe(0);
		expect(second.generation.runtime.getRegisteredProviderIds()).toContain(
			"generation-initializer-probe",
		);
		expect(second.generation.providerStatusIds).toContain("generation-initializer-probe");
		expect(calls).toBe(2);
	} finally {
		configurePiRuntime(null);
		configurePiRuntimeGenerationInitializer();
		isolated.restore();
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("candidate generation reloads an opaque extension replaced at the same path", async () => {
	const root = mkdtempSync(join(tmpdir(), "trpi-extension-generation-"));
	const agentDir = join(root, "agent");
	const extensionPath = join(root, "opaque-extension.ts");
	mkdirSync(agentDir, { recursive: true });
	const isolated = isolateAgentDir(agentDir);
	try {
		writeFileSync(
			extensionPath,
			'export default function syntheticExtension(pi) { pi.registerProvider("opaque-probe", { name: "Opaque" }); }\n',
		);
		const initial = await preparePiRuntimeGeneration([extensionPath]);
		expect(initial.outcome).toBe("prepared");
		if (initial.outcome !== "prepared") return;
		expect(initial.generation.runtime.getRegisteredProviderIds()).toContain("opaque-probe");
		expect(initial.generation.providerStatusIds).not.toContain("opaque-probe");
		expect([...initial.generation.opaqueProviderIds]).toEqual(["opaque-probe"]);
		initial.generation.runtime.registerProvider("later-provider", { name: "Later" });
		expect(initial.generation.opaqueProviderIds.has("later-provider")).toBe(false);
		writeFileSync(extensionPath, 'throw new Error("private replacement diagnostic");\n');
		expect(await preparePiRuntimeGeneration([extensionPath])).toEqual({
			outcome: "failed",
			reason: "candidate-failed",
		});
	} finally {
		configurePiRuntime(null);
		isolated.restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("opaque registrations that replace existing providers stay visible to provider status and are attributed to Central", async () => {
	const root = mkdtempSync(join(tmpdir(), "trpi-opaque-provider-ownership-"));
	const isolated = isolateAgentDir(root);
	configurePiRuntime(null);
	configurePiRuntimeGenerationInitializer((runtime) => {
		runtime.registerProvider("pre-registered", { name: "Host provider", apiKey: "fixture-key" });
	});
	try {
		const plain = await preparePiRuntimeGeneration([]);
		expect(plain.outcome).toBe("prepared");
		if (plain.outcome !== "prepared") throw new Error("plain fixture failed");
		const preExtensionAnthropicName = plain.generation.providerStatusNames.get("anthropic");
		expect(preExtensionAnthropicName).toBeDefined();

		const path = join(root, "opaque.ts");
		writeFileSync(
			path,
			'export default function opaque(pi) { pi.registerProvider("anthropic", { apiKey: "private-key", name: "private-name" }); pi.registerProvider("pre-registered", { apiKey: "private-replacement" }); pi.registerProvider("central-only", { name: "Central only" }); }\n',
		);
		const prepared = await preparePiRuntimeGeneration([path]);
		expect(prepared.outcome).toBe("prepared");
		if (prepared.outcome !== "prepared") throw new Error("opaque fixture failed");
		expect(prepared.generation.providerStatusNames.get("anthropic")).toBe(
			preExtensionAnthropicName,
		);
		expect(prepared.generation.providerStatusNames.get("anthropic")).not.toBe("private-name");
		expect(prepared.generation.providerStatusNames.get("central-only")).toBeUndefined();
		expect([...prepared.generation.providerStatusNames.keys()]).toEqual([
			...prepared.generation.providerStatusIds,
		]);
		for (const id of ["anthropic", "pre-registered"]) {
			expect(prepared.generation.opaqueProviderIds.has(id)).toBe(true);
			expect(prepared.generation.providerStatusIds.has(id)).toBe(true);
		}
		expect(prepared.generation.opaqueProviderIds.has("central-only")).toBe(true);
		expect(prepared.generation.providerStatusIds.has("central-only")).toBe(false);
	} finally {
		configurePiRuntime(null);
		configurePiRuntimeGenerationInitializer();
		isolated.restore();
		rmSync(root, { recursive: true, force: true });
	}
});

test("refresh() on the shared runtime never opts into the network (provider.status must not stall on pi.dev)", async () => {
	const { runtime, agentDir } = await isolatedRuntime();
	try {
		expect(process.env.PI_OFFLINE).toBeUndefined();

		await runtime.setRuntimeApiKey("anthropic", "sk-test-never-used");
		const originalFetch = globalThis.fetch;
		const fetched: string[] = [];
		globalThis.fetch = ((input: string | URL | Request) => {
			fetched.push(String(input instanceof Request ? input.url : input));
			return Promise.reject(new Error("unit tests never touch the network"));
		}) as typeof fetch;
		const registryRefresh = spyOn(runtime.modelRegistry, "refresh");
		try {
			await runtime.refresh({ force: true });
			expect(fetched).toEqual([]);
			expect(registryRefresh.mock.calls.map(([strategy]) => strategy)).toEqual(["offline"]);

			await runtime.refresh({ allowNetwork: true, force: true });
			expect(registryRefresh.mock.calls.map(([strategy]) => strategy)).toEqual([
				"offline",
				"online",
			]);
		} finally {
			registryRefresh.mockRestore();
			globalThis.fetch = originalFetch;
		}
	} finally {
		cleanup(agentDir);
	}
});

test("a user-set PI_OFFLINE survives runtime creation untouched", async () => {
	process.env.PI_OFFLINE = "yes";
	const { agentDir } = await isolatedRuntime();
	try {
		expect(process.env.PI_OFFLINE).toBe("yes");
	} finally {
		cleanup(agentDir);
	}
});

test("an offline refresh rebuilds omp's catalog only when models.yml or stored credentials changed", async () => {
	const { runtime, agentDir } = await isolatedRuntime();
	const registryRefresh = spyOn(runtime.modelRegistry, "refresh");
	const external = await discoverAuthStorage(agentDir);
	try {
		await runtime.refresh();
		await runtime.refresh();
		expect(registryRefresh).not.toHaveBeenCalled();

		writeFileSync(join(agentDir, "models.yml"), "providers: {}\n");
		await runtime.refresh();
		await runtime.refresh();
		expect(registryRefresh.mock.calls.map(([strategy]) => strategy)).toEqual(["offline"]);

		await external.credentials.set("external-login-probe", {
			type: "api_key",
			key: "external-key",
		});
		expect(runtime.getProviderAuthStatus("external-login-probe").configured).toBe(false);
		await runtime.refresh();
		expect(runtime.getProviderAuthStatus("external-login-probe")).toEqual({
			configured: true,
			source: "stored",
		});
		expect(registryRefresh.mock.calls.map(([strategy]) => strategy)).toEqual([
			"offline",
			"offline",
		]);
	} finally {
		external.close();
		registryRefresh.mockRestore();
		cleanup(agentDir);
	}
});

test("a provider registered with an explicit model list keeps exactly that list after omp rebuilds its catalog", async () => {
	const { runtime, agentDir } = await isolatedRuntime();
	try {
		runtime.registerProvider("openai", {
			api: "openai-responses",
			baseUrl: "https://registered.invalid",
			apiKey: "registered-key",
			models: [
				{
					id: "registered-model",
					name: "Registered",
					api: "openai-responses",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				},
			],
		});
		writeFileSync(join(agentDir, "models.yml"), "providers: {}\n");
		await runtime.refresh();

		const merged = runtime.modelRegistry.getProviderModels("openai");
		const builtIn = merged.find((model) => model.id !== "registered-model");
		expect(builtIn).toBeDefined();
		expect(runtime.getModels("openai").map((model) => model.id)).toEqual(["registered-model"]);
		expect(
			runtime
				.getAvailableSnapshot()
				.filter((model) => model.provider === "openai")
				.map((model) => model.id),
		).toEqual(["registered-model"]);
		if (builtIn) expect(runtime.getModel("openai", builtIn.id)).toBeUndefined();

		runtime.unregisterProvider("openai");
		expect(runtime.getModels("openai").length).toBe(
			runtime.modelRegistry.getProviderModels("openai").length,
		);
	} finally {
		cleanup(agentDir);
	}
});

const OK: ModelsRefreshResult = { aborted: false, errors: new Map() };

function fakeRuntime() {
	const calls: ModelsRefreshOptions[] = [];
	let settle = { resolve: (_: ModelsRefreshResult) => {}, reject: (_: unknown) => {} };
	const runtime: CatalogRefreshRuntime = {
		refresh: (options?: ModelsRefreshOptions) => {
			calls.push(options ?? {});
			return new Promise<ModelsRefreshResult>((resolve, reject) => {
				settle = { resolve, reject };
			});
		},
	};
	return {
		runtime,
		calls,
		resolve: (result: ModelsRefreshResult = OK) => settle.resolve(result),
		reject: (err: unknown) => settle.reject(err),
	};
}

const settled = () => new Promise<void>((r) => setTimeout(r, 0));

test("an implicit trigger opts into the network per-call but stays behind pi's freshness throttle", () => {
	const { runtime, calls } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(1);
	const options = calls[0];
	expect(options?.allowNetwork).toBe(true);
	expect(options?.force).toBe(false);
	expect(options?.signal).toBeInstanceOf(AbortSignal);
});

test("an explicit refresh forces past the freshness throttle", () => {
	const { runtime, calls } = fakeRuntime();
	void refreshCatalogs(runtime, { force: true });
	expect(calls[0]?.force).toBe(true);
});

test("a forced refresh does not settle for an in-flight throttled pass — it queues behind it", async () => {
	const { runtime, calls, resolve } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	const forced = refreshCatalogs(runtime, { force: true });
	expect(calls.length).toBe(1);

	resolve();
	await settled();
	expect(calls.length).toBe(2);
	expect(calls[1]?.force).toBe(true);
	resolve();
	await forced;
});

test("an implicit trigger joins an in-flight forced pass (a forced result satisfies it)", () => {
	const { runtime, calls } = fakeRuntime();
	void refreshCatalogs(runtime, { force: true });
	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(1);
});

test("single-flight: repeated triggers while one refresh is pending don't stack network tasks", async () => {
	const { runtime, calls, resolve } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	refreshCatalogsDetached(runtime);
	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(1);

	resolve();
	await settled();
	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(2);
});

test("a rejected refresh is swallowed and does not wedge future refreshes", async () => {
	const { runtime, calls, reject } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	reject(new Error("pi.dev unreachable"));
	await settled();

	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(2);
});

test("an aborted (timed-out) refresh is tolerated and frees the single-flight slot", async () => {
	const { runtime, calls, resolve } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	resolve({ aborted: true, errors: new Map() });
	await settled();

	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(2);
});

test("a caller's await is bounded even when pi's pass never settles", async () => {
	jest.useFakeTimers();
	try {
		const { runtime, calls } = fakeRuntime();
		const awaited = refreshCatalogs(runtime, { force: true });
		jest.advanceTimersByTime(15_000);
		await awaited;

		void refreshCatalogs(runtime, { force: true });
		expect(calls.length).toBe(1);
	} finally {
		jest.useRealTimers();
	}
});

test("per-provider failures in a completed refresh are tolerated (result is only logged)", async () => {
	const { runtime, calls, resolve } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	resolve({ aborted: false, errors: new Map([["someprovider", "boom"]]) });
	await settled();

	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(2);
});

test("awaited refresh shares the single-flight slot with a detached trigger", async () => {
	const { runtime, calls, resolve } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	const awaited = refreshCatalogs(runtime);
	expect(calls.length).toBe(1);

	let done = false;
	void awaited.then(() => {
		done = true;
	});
	await settled();
	expect(done).toBe(false);
	resolve();
	await awaited;
	expect(calls.length).toBe(1);
});

test("awaited refresh RESOLVES on a failed refresh (caller then serves the current snapshot)", async () => {
	const { runtime, reject } = fakeRuntime();
	const awaited = refreshCatalogs(runtime);
	reject(new Error("pi.dev unreachable"));
	await awaited;
});

test("awaited refresh under PI_OFFLINE resolves immediately without a network task", async () => {
	process.env.PI_OFFLINE = "1";
	const { runtime, calls } = fakeRuntime();
	await refreshCatalogs(runtime);
	expect(calls.length).toBe(0);
});

test("PI_OFFLINE disables the refresh entirely", () => {
	process.env.PI_OFFLINE = "1";
	const { runtime, calls } = fakeRuntime();
	refreshCatalogsDetached(runtime);
	expect(calls.length).toBe(0);
});

test("login options carry no host device id: omp providers derive and persist their own", () => {
	expect(Object.keys(piLoginOptions)).toEqual([]);
});
