import { expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { createFauxModelRegistry } from "pi-faux";
import { preferredDefaultModel } from "./modelDefaults";

const { modelRegistry } = await createFauxModelRegistry();
const catalog = modelRegistry.getAll();

function model(provider: string, id: string): Model<Api> {
	const found = catalog.find((candidate) => candidate.provider === provider && candidate.id === id);
	if (!found) throw new Error(`omp's catalog has no ${provider}/${id}`);
	return found;
}

function providerDefault(provider: keyof typeof DEFAULT_MODEL_PER_PROVIDER): Model<Api> {
	return model(provider, DEFAULT_MODEL_PER_PROVIDER[provider]);
}

function otherThanDefault(provider: keyof typeof DEFAULT_MODEL_PER_PROVIDER): Model<Api> {
	const other = catalog.find(
		(candidate) =>
			candidate.provider === provider && candidate.id !== DEFAULT_MODEL_PER_PROVIDER[provider],
	);
	if (!other) throw new Error(`omp's catalog has only the default ${provider} model`);
	return other;
}

test("omp's provider default wins over catalog order", () => {
	const openai = providerDefault("openai");
	expect(preferredDefaultModel([otherThanDefault("openai"), openai])).toBe(openai);
});

test("a signed-in provider's default beats one that is only ambiently available", () => {
	const bedrock = providerDefault("amazon-bedrock");
	const anthropic = providerDefault("anthropic");
	expect(preferredDefaultModel([bedrock, anthropic])).toBe(bedrock);
	expect(preferredDefaultModel([bedrock, anthropic], (provider) => provider === "anthropic")).toBe(
		anthropic,
	);
});

test("without any provider default the first available model is chosen; none yields nothing", () => {
	const first = otherThanDefault("openai");
	expect(preferredDefaultModel([first, otherThanDefault("anthropic")])).toBe(first);
	expect(preferredDefaultModel([])).toBeUndefined();
});
