import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { configurePiRuntimeGenerationInitializer, type NativeProvider } from "./agent";
import { bootHost } from "./host";

if (process.env.THINKRAIL_E2E_FAKE_OAUTH === "1") {
	const fakeOauth = (choice: "subscription" | "api", name: string) => ({
		name,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			let code: string;
			if (choice === "api") {
				callbacks.onAuth({
					url: "https://e2e.test/authorize?probe=1&redirect_uri=https%3A%2F%2Fe2e.test%2Fcode",
					instructions: "Copy the code the sign-in page shows and paste it here.",
				});
				code = await callbacks.onPrompt({ message: "Paste the code E2E shows after you sign in:" });
			} else {
				callbacks.onAuth({
					url: "https://e2e.test/authorize?probe=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcallback",
				});
				code = (await callbacks.onManualCodeInput?.(callbacks.signal)) ?? "";
			}
			callbacks.onProgress?.("Exchanging authorization code…");
			return {
				refresh: "e2e-refresh",
				access: `e2e-access-${choice}-${code}`,
				expires: 4102444800000,
			};
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return credentials;
		},
		getApiKey(credentials: OAuthCredentials): string {
			return String(credentials.access);
		},
	});
	const fakeApiKeyProvider: NativeProvider = {
		id: "e2e-apikey",
		name: "E2E Key Provider",
		config: {
			baseUrl: "http://e2e-apikey.test",
			api: "openai-completions",
			models: [
				{
					id: "e2e-key-model",
					name: "E2E Key Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				},
			],
		},
		apiKeyLogin: {
			async login(interaction) {
				const key = await interaction.prompt({
					type: "secret",
					message: "Enter your E2E Key Provider API key",
					placeholder: "e2e-...",
				});
				if (!key.trim()) throw new Error("API key must not be empty");
				return { type: "api_key", key: key.trim() };
			},
		},
	};
	configurePiRuntimeGenerationInitializer((runtime) => {
		runtime.registerProvider("e2e-oauth", {
			name: "E2E Test Provider",
			oauth: fakeOauth("subscription", "E2E Test Provider"),
		});
		runtime.registerProvider("e2e-oauth-code", {
			name: "E2E Code Provider",
			oauth: fakeOauth("api", "E2E Code Provider"),
		});
		runtime.registerNativeProvider(fakeApiKeyProvider);
	});
}

const host = process.env.THINKRAIL_HOST ?? "localhost";
const staticDir = process.env.THINKRAIL_STATIC_DIR;
const envPort = process.env.THINKRAIL_PORT;

const { port } = await bootHost({
	port: envPort ? Number(envPort) : 24242,
	host,
	portMode: envPort ? "exact" : "free",
	resolveShellEnv: true,
	...(staticDir ? { staticDir } : {}),
	analytics: { channel: "dev", build: "source" },
});
console.log(`thinkrail host: http://${host}:${port}`);
