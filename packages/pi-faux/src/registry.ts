import { type Api, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry, type ProviderConfigInput, type Settings } from "@oh-my-pi/pi-coding-agent";
import type { FauxCore, FauxProviderHandle } from "./faux";

export interface FauxModelRegistry {
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
}

export async function createFauxModelRegistry(settings?: Settings): Promise<FauxModelRegistry> {
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, undefined, {
		ignoreLocalModelConfig: true,
		...(settings ? { settings } : {}),
	});
	return { authStorage, modelRegistry };
}

export function registerFaux(
	registry: ModelRegistry,
	faux: FauxCore | FauxProviderHandle,
	overrides: Partial<ProviderConfigInput> = {},
): Model<Api> {
	const config =
		"providerConfig" in faux
			? faux.providerConfig(overrides)
			: { ...faux.provider.config, ...overrides };
	registry.registerProvider(providerId(faux), config);
	const id = faux.getModel().id;
	const model = registry.find(providerId(faux), id);
	if (!model) throw new Error(`faux model ${providerId(faux)}/${id} did not register`);
	return model;
}

function providerId(faux: FauxCore | FauxProviderHandle): string {
	return typeof faux.provider === "string" ? faux.provider : faux.provider.id;
}
