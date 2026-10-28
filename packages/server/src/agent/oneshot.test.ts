import { afterEach, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "pi-faux";
import { ModelRuntime } from "./modelRuntime";
import { completeOnce, pickModel } from "./oneshot";
import { configurePiRuntime } from "./piRuntime";

function modelDef(id: string, cost = 0) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

interface StubModel {
	provider: string;
	id: string;
	cost: number;
}

async function stubAvailable(models: StubModel[]): Promise<void> {
	const runtime = await ModelRuntime.create({
		inMemoryCredentials: true,
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (const provider of new Set(models.map((model) => model.provider))) {
		runtime.registerProvider(provider, {
			api: `faux-${provider}`,
			baseUrl: "http://faux.local",
			apiKey: "faux",
			models: models
				.filter((model) => model.provider === provider)
				.map((model) => ({ ...modelDef(model.id, model.cost), api: `faux-${provider}` })),
		});
	}
	const registered = models.flatMap((model): Model<Api>[] => {
		const found = runtime.getModel(model.provider, model.id);
		return found ? [found] : [];
	});
	runtime.getAvailableSnapshot = () => registered;
	configurePiRuntime(runtime);
}

function withProvider(provider: string, id: string, cost = 0): StubModel {
	return { provider, id, cost };
}

afterEach(() => {
	configurePiRuntime(null);
});

test("pickModel(cheap) prefers a known small model (allowlist) over a cheaper unlisted one", async () => {
	await stubAvailable([
		withProvider("anthropic", "claude-haiku-faux", 10),
		withProvider("cheapo", "cheapo-1", 1),
	]);
	expect((await pickModel("cheap"))?.id).toBe("claude-haiku-faux");
});

test("pickModel(cheap) falls back to the cheapest by token cost when nothing is allowlisted", async () => {
	await stubAvailable([
		withProvider("pricey", "pricey-1", 10),
		withProvider("cheapo", "cheapo-1", 1),
	]);
	expect((await pickModel("cheap"))?.id).toBe("cheapo-1");
});

test("pickModel(cheap) skips unpriced models and falls back to the default model when none is priced", async () => {
	await stubAvailable([withProvider("free", "free-1", 0), withProvider("cheapo", "cheapo-1", 1)]);
	expect((await pickModel("cheap"))?.id).toBe("cheapo-1");
	await stubAvailable([withProvider("free", "free-1", 0), withProvider("openai", "gpt-5.5", 0)]);
	expect((await pickModel("cheap"))?.id).toBe("gpt-5.5");
});

test("pickModel(default) returns the first available model; empty set → null", async () => {
	await stubAvailable([
		withProvider("pricey", "pricey-1", 10),
		withProvider("cheapo", "cheapo-1", 1),
	]);
	expect((await pickModel("default"))?.id).toBe("pricey-1");
	await stubAvailable([]);
	expect(await pickModel("cheap")).toBeNull();
	expect(await pickModel("default")).toBeNull();
});

test("completeOnce throws 'no-model' when nothing is authenticated", async () => {
	await stubAvailable([]);
	await expect(completeOnce({ prompt: "hi" })).rejects.toThrow("no-model");
});

test("completeOnce dispatches a single request on the picked model and returns its text", async () => {
	const faux = createFauxCore({
		provider: "anthropic",
		api: "faux-anthropic",
		models: [modelDef("claude-haiku-faux")],
		tokensPerSecond: 5000,
	});
	const runtime = await ModelRuntime.create({
		inMemoryCredentials: true,
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("anthropic", faux.providerConfig());
	const haiku = runtime.getModel("anthropic", "claude-haiku-faux");
	runtime.getAvailableSnapshot = () => (haiku ? [haiku] : []);
	configurePiRuntime(runtime);
	let systemPrompt: readonly string[] | undefined;
	faux.setResponses([
		(context) => {
			systemPrompt = context.systemPrompt;
			return fauxAssistantMessage("add-login-flow");
		},
	]);

	const result = await completeOnce({
		system: "name it",
		prompt: "add a login flow",
		maxTokens: 24,
	});
	expect(result.text).toBe("add-login-flow");
	expect(systemPrompt).toEqual(["name it"]);
	expect(result.model).toEqual({ provider: "anthropic", id: "claude-haiku-faux" });
});
