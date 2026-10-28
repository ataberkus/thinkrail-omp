import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	type ModelListingRuntime,
	refreshModelListings,
	setModelListingPublisher,
} from "./modelAvailability";
import { ModelRuntime } from "./modelRuntime";
import { settledAvailableModels } from "./piRuntime";

let priorOffline: string | undefined;
let servers: ReturnType<typeof Bun.serve>[] = [];

beforeEach(() => {
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
});

afterEach(() => {
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
	for (const server of servers) server.stop(true);
	servers = [];
	setModelListingPublisher(null);
});

async function runtimeWith(
	credentials: Record<string, Parameters<AuthStorage["credentials"]["set"]>[1]>,
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		inMemoryCredentials: true,
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (const [providerId, credential] of Object.entries(credentials))
		await runtime.authStorage.credentials.set(providerId, credential);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

function modelIds(runtime: ModelRuntime, provider: string): string[] {
	return settledAvailableModels(runtime)
		.filter((model) => model.provider === provider)
		.map((model) => model.id);
}

function serveListing(
	route: string,
	ids: string[],
	accept: (request: Request) => boolean = () => true,
): string {
	const server = Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === route && accept(request)
				? Response.json({ data: ids.map((id) => ({ id })) })
				: new Response("not found", { status: 404 }),
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

test("an OpenAI API key keeps the full OpenAI catalog", async () => {
	const runtime = await runtimeWith({
		openai: { type: "api_key", key: "sk-test" },
	});
	expect(modelIds(runtime, "openai")).toContain("gpt-4");
});

test("a proxy's advertised listing hides catalog models it does not serve, matching dated aliases", async () => {
	const runtime = await runtimeWith({});
	const openai = serveListing(
		"/v1/models",
		["gpt-5.5-2026-04-23", "gpt-4o-2024-11-20", "gpt-6-sol"],
		(request) => request.headers.get("authorization") === "Bearer wire-proxy",
	);
	const anthropic = serveListing(
		"/v1/models",
		["claude-opus-4-8", "claude-sonnet-4-5-20250929"],
		(request) =>
			request.headers.get("x-api-key") === "wire-proxy" &&
			request.headers.get("anthropic-version") !== null,
	);
	runtime.registerProvider("openai", { baseUrl: `${openai}/v1`, apiKey: "wire-proxy" });
	runtime.registerProvider("anthropic", { baseUrl: anthropic, apiKey: "wire-proxy" });
	await runtime.refresh({ allowNetwork: false });
	expect(modelIds(runtime, "openai")).toContain("gpt-4");
	let published = 0;
	setModelListingPublisher(() => {
		published += 1;
	});

	expect(await refreshModelListings(runtime, new Set(["openai", "anthropic"]))).toBe(true);

	expect(published).toBe(1);
	expect(modelIds(runtime, "openai").sort()).toEqual([
		"gpt-4o",
		"gpt-4o-2024-11-20",
		"gpt-5.5",
		"gpt-6-sol",
	]);
	expect(modelIds(runtime, "anthropic").sort()).toEqual([
		"claude-opus-4-8",
		"claude-sonnet-4-5",
		"claude-sonnet-4-5-20250929",
	]);
	expect(await refreshModelListings(runtime, new Set(["openai", "anthropic"]))).toBe(false);
	expect(
		await refreshModelListings(runtime, new Set(["openai", "anthropic"]), { force: true }),
	).toBe(false);
	expect(published).toBe(1);
});

test("a failed re-read keeps the last advertised listing", async () => {
	const runtime = await runtimeWith({});
	let up = true;
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			up
				? Response.json({ data: [{ id: "gpt-5.5" }] })
				: new Response("unavailable", { status: 503 }),
	});
	servers.push(server);
	runtime.registerProvider("openai", {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		apiKey: "wire-proxy",
	});
	await runtime.refresh({ allowNetwork: false });
	expect(await refreshModelListings(runtime, new Set(["openai"]))).toBe(true);
	up = false;

	expect(await refreshModelListings(runtime, new Set(["openai"]), { force: true })).toBe(false);

	expect(modelIds(runtime, "openai")).toEqual(["gpt-5.5"]);
});

test("an unreadable listing leaves the catalog unfiltered", async () => {
	const runtime = await runtimeWith({});
	const proxy = serveListing("/elsewhere", []);
	runtime.registerProvider("openai", { baseUrl: `${proxy}/v1`, apiKey: "wire-proxy" });
	await runtime.refresh({ allowNetwork: false });

	expect(await refreshModelListings(runtime, new Set(["openai"]))).toBe(false);

	expect(modelIds(runtime, "openai")).toContain("gpt-4");
});

test("a stalled credential resolver cannot wedge listing refreshes past the deadline", async () => {
	let authSignal: AbortSignal | undefined;
	const base = (await runtimeWith({})).getModels("openai")[0];
	if (!base) throw new Error("openai catalog is empty");
	const runtime: ModelListingRuntime = {
		getModels: () => [{ ...base, baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions" }],
		getAuth: (_target, options) => {
			authSignal = options?.signal;
			return new Promise<never>(() => {});
		},
	};
	const started = Date.now();
	expect(await refreshModelListings(runtime, new Set(["openai"]))).toBe(false);
	expect(Date.now() - started).toBeLessThan(7_000);
	expect(authSignal?.aborted).toBe(true);
	expect(await refreshModelListings(runtime, new Set(["openai"]), { force: true })).toBe(false);
}, 15_000);
