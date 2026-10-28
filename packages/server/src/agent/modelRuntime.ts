import { statSync } from "node:fs";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	AuthStorage,
	type Context,
	completeSimple as completeWithModel,
	getEnvApiKeyName,
	getOAuthProviders,
	getProviderDefinition,
	listProvidersWithEnvKey,
	type Model,
	type OAuthLoginCallbacks,
	PROVIDER_REGISTRY,
	resolveUsedFraction,
	type SimpleStreamOptions,
	streamSimple as streamWithModel,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import {
	discoverAuthStorage,
	getAgentDir,
	ModelRegistry,
	type ProviderConfig,
	type ProviderConfigInput,
	type ProviderModelConfig,
	type Settings,
} from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import type { ProviderUsageLimit, ProviderUsageProvider } from "@thinkrail/contracts";

function accountLabel(metadata: Record<string, unknown> | undefined): string | undefined {
	const text = (key: string) => {
		const value = metadata?.[key];
		return typeof value === "string" && value ? value : undefined;
	};
	const parts = [
		text("email") ?? text("accountId") ?? text("projectId"),
		text("orgName") ?? text("orgId"),
		text("planType"),
	].filter((part) => part !== undefined);
	return parts.length ? parts.join(" · ") : undefined;
}

export function toProviderUsage(
	reports: readonly UsageReport[],
	nameOf: (providerId: string) => string,
): ProviderUsageProvider[] {
	const providers = new Map<string, ProviderUsageProvider>();
	for (const report of reports) {
		if (!Array.isArray(report.limits) || report.limits.length === 0) continue;
		let provider = providers.get(report.provider);
		if (!provider) {
			provider = { providerId: report.provider, name: nameOf(report.provider), accounts: [] };
			providers.set(report.provider, provider);
		}
		const account = accountLabel(report.metadata);
		const limits = new Map<string, ProviderUsageLimit>();
		for (const limit of report.limits) {
			const used = resolveUsedFraction(limit);
			const resetsAt = limit.window?.resetsAt;
			const detail = [limit.window?.label, limit.scope?.modelId, limit.scope?.tier]
				.filter(
					(part): part is string =>
						!!part && !limit.label.toLowerCase().includes(part.toLowerCase()),
				)
				.join(" · ");
			const entry: ProviderUsageLimit = {
				label: limit.label,
				...(detail ? { detail } : {}),
				usedFraction: used !== undefined && Number.isFinite(used) ? Math.max(0, used) : null,
				...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}),
			};
			// Routing-specific copies of one upstream quota arrive as identical entries.
			limits.set(JSON.stringify(entry), entry);
		}
		provider.accounts.push({ ...(account ? { account } : {}), limits: [...limits.values()] });
	}
	return [...providers.values()];
}

export type AuthType = "oauth" | "api_key";

export type AuthStatusSource =
	| "stored"
	| "runtime"
	| "environment"
	| "fallback"
	| "models_json_key"
	| "models_json_command";

export interface AuthStatus {
	configured: boolean;
	source?: AuthStatusSource;
	label?: string;
}

export type AuthPrompt =
	| {
			type: "select";
			message: string;
			options: readonly { id: string; label: string }[];
			signal?: AbortSignal;
	  }
	| {
			type: "text" | "secret" | "manual_code";
			message: string;
			placeholder?: string;
			signal?: AbortSignal;
	  };

export type AuthNotice =
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
	| { type: "progress"; message: string }
	| { type: "info"; message: string; links?: readonly { url: string }[] };

export interface AuthInteraction {
	signal?: AbortSignal;
	notify(event: AuthNotice): void;
	prompt(prompt: AuthPrompt): Promise<string>;
}

export type LoginOptions = Readonly<Record<string, never>>;

export interface ApiKeyLogin {
	login(interaction: AuthInteraction): Promise<{ type: "api_key"; key: string }>;
}

export interface HostProviderConfig extends ProviderConfigInput {
	name?: string;
}

export interface NativeProvider {
	readonly id: string;
	readonly name: string;
	readonly config: HostProviderConfig;
	readonly apiKeyLogin?: ApiKeyLogin;
}

export interface HostProvider {
	readonly id: string;
	readonly name: string;
	readonly auth: {
		readonly oauth?: { readonly name: string; readonly isSubscription?: boolean };
		readonly apiKey?: { readonly login: boolean };
	};
}

export interface CredentialInfo {
	providerId: string;
	type: AuthType;
}

export interface ResolvedAuth {
	auth: { apiKey?: string; headers?: Record<string, string> };
}

export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, string>;
}

export interface CreateModelRuntimeOptions {
	agentDir?: string;
	inMemoryCredentials?: boolean;
	modelsPath?: string | null;
	allowModelNetwork?: boolean;
	settings?: Settings;
}

type RegistryModelConfig = NonNullable<ProviderConfigInput["models"]>[number];

function registryModel(model: ProviderModelConfig): RegistryModelConfig {
	const { kind, thinking, ...rest } = model;
	return {
		...rest,
		...(kind === undefined ? {} : { kind }),
		...(thinking === undefined ? {} : { thinking }),
	};
}

export function registryProviderConfig(config: ProviderConfig): ProviderConfigInput {
	const { models, fetchDynamicModels, ...rest } = config;
	return {
		...rest,
		...(models ? { models: models.map(registryModel) } : {}),
		...(fetchDynamicModels
			? {
					fetchDynamicModels: async (apiKey: string | undefined) =>
						(await fetchDynamicModels(apiKey)).map(registryModel),
				}
			: {}),
	};
}

const SUBSCRIPTION_SIGN_INS: ReadonlySet<string> = new Set([
	"anthropic",
	"github-copilot",
	"kimi-code",
	"muse-code",
	"openai-codex",
	"xai-oauth",
]);

function oauthInteraction(callbacks: OAuthLoginCallbacks): AuthInteraction {
	return {
		...(callbacks.signal ? { signal: callbacks.signal } : {}),
		notify: (event) => {
			if (event.type === "auth_url")
				callbacks.onAuth({
					url: event.url,
					...(event.instructions ? { instructions: event.instructions } : {}),
				});
			else if (event.type === "progress" || event.type === "info")
				callbacks.onProgress?.(event.message);
		},
		prompt: (prompt) =>
			prompt.type === "select"
				? Promise.reject(new Error("This sign-in needs a choice omp cannot present"))
				: callbacks.onPrompt({
						message: prompt.message,
						...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
						...(prompt.type === "secret" ? { secret: true } : {}),
					}),
	};
}

const ENV_KEY_PROVIDERS: ReadonlySet<string> = new Set(listProvidersWithEnvKey());

function acceptsApiKey(providerId: string): boolean {
	return (
		ENV_KEY_PROVIDERS.has(providerId) &&
		getProviderDefinition(providerId)?.allowsMissingApiKey !== true &&
		!getEnvApiKeyName(providerId)?.endsWith("_OAUTH_TOKEN")
	);
}

const REGISTRY_NAMES = new Map(
	PROVIDER_REGISTRY.map((definition) => [definition.id, definition.name]),
);

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ModelRuntime {
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly #registrations = new Map<string, HostProviderConfig>();
	readonly #natives = new Map<string, NativeProvider>();
	readonly #keyLoginOnly = new Set<string>();
	readonly #networkAllowed: boolean;
	readonly modelsConfigPath: string | undefined;
	#refreshedLocalInputs: string | undefined;
	readonly #replacedCatalogs = new Map<string, ReadonlySet<string>>();

	private constructor(
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
		networkAllowed: boolean,
		modelsConfigPath: string | undefined,
	) {
		this.authStorage = authStorage;
		this.modelRegistry = modelRegistry;
		this.#networkAllowed = networkAllowed;
		this.modelsConfigPath = modelsConfigPath;
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const agentDir = options.agentDir ?? getAgentDir();
		const authStorage = options.inMemoryCredentials
			? await AuthStorage.create(":memory:")
			: await discoverAuthStorage(agentDir);
		const modelRegistry = new ModelRegistry(
			authStorage,
			options.modelsPath === null ? undefined : options.modelsPath,
			{
				ignoreLocalModelConfig: options.modelsPath === null,
				...(options.settings ? { settings: options.settings } : {}),
			},
		);
		const runtime = new ModelRuntime(
			authStorage,
			modelRegistry,
			options.allowModelNetwork === true,
			options.modelsPath === null
				? undefined
				: (options.modelsPath ?? join(getAgentDir(), "models.yml")),
		);
		await modelRegistry.refresh(options.allowModelNetwork ? "online-if-uncached" : "offline");
		runtime.#refreshedLocalInputs = runtime.#localInputs();
		return runtime;
	}

	#localInputs(): string {
		const credentials = this.authStorage.credentials
			.list()
			.map((stored) => `${stored.id}:${stored.provider}:${stored.disabledCause ?? ""}`)
			.sort()
			.join(",");
		if (this.modelsConfigPath === undefined) return credentials;
		const file = ModelsConfigFile.relocate(this.modelsConfigPath).path();
		try {
			const { ino, size, mtimeMs } = statSync(file);
			return `${file}:${ino}:${size}:${mtimeMs}|${credentials}`;
		} catch {
			return `${file}|${credentials}`;
		}
	}

	getProviders(): readonly HostProvider[] {
		const ids = new Set<string>([
			...this.modelRegistry.getAll().map((model) => model.provider),
			...this.#registrations.keys(),
			...getOAuthProviders().map((provider) => provider.storeCredentialsAs ?? provider.id),
		]);
		return [...ids].map((id) => this.#describe(id));
	}

	getProvider(providerId: string): HostProvider | undefined {
		if (
			!this.#registrations.has(providerId) &&
			!this.modelRegistry.hasProvider(providerId) &&
			!this.#oauthProvider(providerId)
		)
			return undefined;
		return this.#describe(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.#registeredCatalog(
			providerId === undefined
				? this.modelRegistry.getAll()
				: this.modelRegistry.getProviderModels(providerId),
		);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		const model = this.modelRegistry.find(providerId, modelId);
		return model && this.#inRegisteredCatalog(model) ? model : undefined;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.#registeredCatalog(this.modelRegistry.getAvailable());
	}

	#inRegisteredCatalog(model: Model<Api>): boolean {
		return this.#replacedCatalogs.get(model.provider)?.has(model.id) ?? true;
	}

	#registeredCatalog(models: Model<Api>[]): readonly Model<Api>[] {
		return this.#replacedCatalogs.size === 0
			? models
			: models.filter((model) => this.#inRegisteredCatalog(model));
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		const available = this.getAvailableSnapshot();
		return providerId === undefined
			? available
			: available.filter((model) => model.provider === providerId);
	}

	getError(): string | undefined {
		const error = this.modelRegistry.getError();
		return error ? errorText(error) : undefined;
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		const origin = this.authStorage.keys.source(providerId, { env: "aliases" });
		if (!origin) return { configured: false };
		switch (origin.kind) {
			case "oauth":
			case "api_key":
				return { configured: true, source: "stored" };
			case "runtime":
				return { configured: true, source: "runtime" };
			case "env":
				return origin.envVar
					? { configured: true, source: "environment", label: origin.envVar }
					: { configured: true, source: "environment" };
			case "config":
				return this.#registrations.get(providerId)?.apiKey !== undefined
					? { configured: true, source: "fallback" }
					: { configured: true, source: "models_json_key" };
		}
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.getProviderAuthStatus(providerId).configured;
	}

	isUsingOAuth(providerId: string): boolean {
		return this.authStorage.keys.source(providerId)?.kind === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return SUBSCRIPTION_SIGN_INS.has(providerId) && this.isUsingOAuth(providerId);
	}

	async getAuth(
		target: string | Model<Api>,
		options: { signal?: AbortSignal } = {},
	): Promise<ResolvedAuth | undefined> {
		const model = typeof target === "string" ? this.getModels(target)[0] : target;
		if (!model) {
			if (typeof target !== "string") return undefined;
			const apiKey = await this.modelRegistry.getApiKeyForProvider(
				target,
				undefined,
				options.signal ? { signal: options.signal } : {},
			);
			return apiKey === undefined ? undefined : { auth: { apiKey } };
		}
		const resolved = await this.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok) return undefined;
		return {
			auth: {
				...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
				...(resolved.headers === undefined ? {} : { headers: resolved.headers }),
			},
		};
	}

	async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
		this.authStorage.keys.setRuntime(providerId, apiKey);
	}

	async removeRuntimeApiKey(providerId: string): Promise<void> {
		this.authStorage.keys.removeRuntime(providerId);
	}

	async usageLimits(force: boolean): Promise<ProviderUsageProvider[]> {
		if (force) await this.authStorage.usage.invalidate();
		const reports = await this.authStorage.usage.reports({
			baseUrlResolver: (provider) => this.modelRegistry.getProviderBaseUrl(provider),
		});
		return toProviderUsage(reports ?? [], (id) => this.getProvider(id)?.name ?? id);
	}

	async listCredentials(): Promise<readonly CredentialInfo[]> {
		const seen = new Map<string, AuthType>();
		for (const stored of this.authStorage.credentials.list()) {
			if (stored.disabledCause !== null) continue;
			const type: AuthType = stored.credential.type === "oauth" ? "oauth" : "api_key";
			if (!seen.has(stored.provider) || type === "oauth") seen.set(stored.provider, type);
		}
		return [...seen].map(([providerId, type]) => ({ providerId, type }));
	}

	async login(
		providerId: string,
		type: AuthType,
		interaction: AuthInteraction,
		_options: LoginOptions = {},
	): Promise<void> {
		if (type === "api_key") {
			const native = this.#natives.get(providerId)?.apiKeyLogin;
			const credential = native
				? await native.login(interaction)
				: {
						type: "api_key" as const,
						key: (
							await interaction.prompt({
								type: "secret",
								message: `Enter the API key for ${this.#describe(providerId).name}`,
								...(interaction.signal ? { signal: interaction.signal } : {}),
							})
						).trim(),
					};
			if (!credential.key) throw new Error("API key must not be empty");
			await this.authStorage.credentials.set(providerId, credential);
			return;
		}
		const oauthId = this.#oauthProvider(providerId)?.id ?? providerId;
		await this.authStorage.oauth.login(oauthId, {
			...(interaction.signal ? { signal: interaction.signal } : {}),
			onAuth: (info) =>
				interaction.notify({
					type: "auth_url",
					url: info.url,
					...(info.instructions ? { instructions: info.instructions } : {}),
				}),
			onProgress: (message) => interaction.notify({ type: "progress", message }),
			onPrompt: (prompt) =>
				interaction.prompt({
					type: prompt.secret ? "secret" : "text",
					message: prompt.message,
					...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
					...(interaction.signal ? { signal: interaction.signal } : {}),
				}),
			onManualCodeInput: (signal) =>
				interaction.prompt({
					type: "manual_code",
					message: "Paste the authorization code or redirect URL",
					...(signal ? { signal } : {}),
				}),
		});
	}

	async logout(providerId: string): Promise<void> {
		await this.authStorage.credentials.remove(providerId);
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		if (options.signal?.aborted) return { aborted: true, errors: new Map() };
		const online = (options.allowNetwork ?? this.#networkAllowed) && !process.env.PI_OFFLINE;
		const strategy = online ? (options.force ? "online" : "online-if-uncached") : "offline";
		const errors = new Map<string, string>();
		const work = async (): Promise<void> => {
			await this.authStorage.reload();
			const localInputs = this.#localInputs();
			if (strategy === "offline" && !options.force && localInputs === this.#refreshedLocalInputs)
				return;
			await this.modelRegistry.refresh(strategy);
			this.#refreshedLocalInputs = localInputs;
		};
		if (!options.signal) {
			await work();
			return { aborted: false, errors };
		}
		const signal = options.signal;
		const aborted = new Promise<"aborted">((resolve) =>
			signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
		);
		const outcome = await Promise.race([work().then(() => "done" as const), aborted]);
		return { aborted: outcome === "aborted", errors };
	}

	registerProvider(providerId: string, config: HostProviderConfig): void {
		const { name: _name, ...registryConfig } = config;
		this.modelRegistry.registerProvider(providerId, registryConfig);
		this.#registrations.set(providerId, config);
		if (config.models?.length && !config.fetchDynamicModels && !config.oauth?.modifyModels)
			this.#replacedCatalogs.set(providerId, new Set(config.models.map((model) => model.id)));
		else this.#replacedCatalogs.delete(providerId);
	}

	unregisterProvider(providerId: string): void {
		this.modelRegistry.unregisterProvider(providerId);
		this.#registrations.delete(providerId);
		this.#replacedCatalogs.delete(providerId);
		this.#natives.delete(providerId);
		this.#keyLoginOnly.delete(providerId);
	}

	registerNativeProvider(provider: NativeProvider): void {
		const keyLogin = provider.apiKeyLogin;
		const config: HostProviderConfig =
			keyLogin && provider.config.apiKey === undefined && provider.config.oauth === undefined
				? {
						...provider.config,
						oauth: {
							name: provider.name,
							login: async (callbacks) => (await keyLogin.login(oauthInteraction(callbacks))).key,
						},
					}
				: provider.config;
		this.registerProvider(provider.id, { name: provider.name, ...config });
		this.#natives.set(provider.id, provider);
		if (config !== provider.config) this.#keyLoginOnly.add(provider.id);
		else this.#keyLoginOnly.delete(provider.id);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...this.#registrations.keys()];
	}

	getRegisteredProviderConfig(providerId: string): HostProviderConfig | undefined {
		return this.#natives.has(providerId) ? undefined : this.#registrations.get(providerId);
	}

	getRegisteredNativeProvider(providerId: string): NativeProvider | undefined {
		return this.#natives.get(providerId);
	}

	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		return streamWithModel(model, context, options);
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions = {},
	): Promise<AssistantMessage> {
		const resolved = await this.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok) throw new Error(resolved.error);
		return completeWithModel(model, context, {
			...options,
			...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
			...(resolved.headers === undefined
				? {}
				: { headers: { ...resolved.headers, ...options.headers } }),
		});
	}

	#oauthProvider(providerId: string) {
		return getOAuthProviders().find(
			(provider) => provider.id === providerId || provider.storeCredentialsAs === providerId,
		);
	}

	#describe(providerId: string): HostProvider {
		const native = this.#natives.get(providerId);
		const oauth = this.#keyLoginOnly.has(providerId) ? undefined : this.#oauthProvider(providerId);
		const name =
			native?.name ??
			this.#registrations.get(providerId)?.name ??
			REGISTRY_NAMES.get(providerId) ??
			oauth?.name ??
			providerId;
		const registered = this.#registrations.get(providerId);
		const apiKeyLogin =
			native?.apiKeyLogin !== undefined || (registered === undefined && acceptsApiKey(providerId));
		return {
			id: providerId,
			name,
			auth: {
				...(oauth
					? {
							oauth: {
								name: oauth.name,
								...(SUBSCRIPTION_SIGN_INS.has(providerId) ? { isSubscription: true } : {}),
							},
						}
					: {}),
				...(apiKeyLogin ? { apiKey: { login: true } } : {}),
			},
		};
	}
}
