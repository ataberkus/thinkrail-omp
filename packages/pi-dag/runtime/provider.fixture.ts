import { type ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { createFauxCore, createFauxModelRegistry } from "pi-faux";

export const model = { provider: "dag-faux", id: "worker" };
export const faux = createFauxCore({
	provider: model.provider,
	api: "dag-faux",
	tokensPerSecond: 100_000,
});

export async function createTestRuntime(prompts?: string[]): Promise<ModelRegistry> {
	const { modelRegistry } = await createFauxModelRegistry(Settings.isolated({}));
	modelRegistry.registerProvider(model.provider, {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "synthetic",
		streamSimple: (model, context, options) => {
			prompts?.push(JSON.stringify(context.messages));
			return faux.streamSimple(model, context, options);
		},
		models: [
			{
				id: model.id,
				name: "Worker",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
	});
	return modelRegistry;
}
