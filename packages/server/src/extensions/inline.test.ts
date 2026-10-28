import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { ExtensionSessionServices } from "@thinkrail/extension-api/server";
import { createFauxCore, createFauxModelRegistry, registerFaux } from "pi-faux";
import {
	type RegistryExtensionFactory,
	registryInlineExtensions,
	registryToolOwner,
} from "./inline";
import type { ServerExtensionEntry } from "./registry";

function toolNamed(name: string): Parameters<ExtensionAPI["registerTool"]>[0] {
	const parameters = { type: "object", properties: {} };
	return {
		name,
		label: name,
		description: name,
		parameters,
		execute: async () => ({ content: [{ type: "text", text: name }] }),
	};
}

function entry(name: string, parents: number, children = 0): ServerExtensionEntry {
	const factories = (prefix: string, count: number) =>
		Array.from({ length: count }, (_, index) => (pi: ExtensionAPI) => {
			pi.registerTool(toolNamed(`${name}-${prefix}${index}`));
		});
	return {
		specifier: `@acme/${name}/server`,
		extension: {
			name,
			extensions: factories("p", parents),
			...(children ? { childExtensions: factories("c", children) } : {}),
		},
	};
}

async function registered(factory: ExtensionFactory): Promise<string[]> {
	const tools: string[] = [];
	const pi = { registerTool: (tool: { name: string }) => tools.push(tool.name) };
	await factory(pi as unknown as ExtensionAPI);
	return tools;
}

const nameOf = (factory: RegistryExtensionFactory) => factory.registryName;

describe("registryInlineExtensions", () => {
	const entries = [entry("solo", 1), entry("multi", 2, 1)];

	it("tags every factory with the extension that owns it", () => {
		expect(registryInlineExtensions("extensions", undefined, entries).map(nameOf)).toEqual([
			"solo",
			"multi",
			"multi",
		]);
		expect(registryInlineExtensions("childExtensions", undefined, entries).map(nameOf)).toEqual([
			"multi",
		]);
	});

	it("decides at load time whether a factory registers anything", async () => {
		const disabled = new Set<string>();
		const [solo] = registryInlineExtensions("extensions", (name) => disabled.has(name), entries);
		if (!solo) throw new Error("missing solo");
		expect(await registered(solo)).toEqual(["solo-p0"]);
		disabled.add("solo");
		expect(await registered(solo)).toEqual([]);
		disabled.delete("solo");
		expect(await registered(solo)).toEqual(["solo-p0"]);
	});

	it("records which extension registered each tool and reports what loaded", async () => {
		const loaded: string[] = [];
		const factories = registryInlineExtensions(
			"extensions",
			undefined,
			entries,
			undefined,
			(name) => loaded.push(name),
		);
		for (const factory of factories) await registered(factory);
		expect(registryToolOwner("solo-p0")).toBe("solo");
		expect(registryToolOwner("multi-p1")).toBe("multi");
		expect(registryToolOwner("unknown-tool")).toBeUndefined();
		expect(loaded).toEqual(["solo", "multi", "multi"]);
	});
});

describe("registryInlineExtensions with per-session factories", () => {
	const labels = new WeakMap<ExtensionSessionServices, string>();
	const session = (label: string): ExtensionSessionServices => {
		const services: ExtensionSessionServices = {
			expectToolResponse: () => {},
			awaitToolResponse: async () => ({ kind: "deferred" }),
			endRun: () => {},
		};
		labels.set(services, label);
		return services;
	};
	const sessionEntry = (name: string, parents: number, seen: string[]): ServerExtensionEntry => ({
		specifier: `@acme/${name}/server`,
		extension: {
			name,
			extensions: entry(name, parents).extension.extensions,
			sessionExtensions: (services) => {
				const label = labels.get(services) ?? "unknown";
				seen.push(label);
				return [
					(pi: ExtensionAPI) => {
						pi.registerTool(toolNamed(`${name}-session-${label}`));
					},
				];
			},
		},
	});

	it("appends the session's factories to the parent set under the same owner", async () => {
		const seen: string[] = [];
		const entries = [sessionEntry("asker", 0, seen), sessionEntry("mixed", 1, seen)];
		const inline = registryInlineExtensions("extensions", undefined, entries, session("a"));
		expect(inline.map(nameOf)).toEqual(["asker", "mixed", "mixed"]);
		expect(await Promise.all(inline.map(registered))).toEqual([
			["asker-session-a"],
			["mixed-p0"],
			["mixed-session-a"],
		]);
		expect(seen).toEqual(["a", "a"]);
	});

	it("builds each parent session's factories from its own services", async () => {
		const seen: string[] = [];
		const entries = [sessionEntry("asker", 0, seen)];
		const [first] = registryInlineExtensions("extensions", undefined, entries, session("one"));
		const [second] = registryInlineExtensions("extensions", undefined, entries, session("two"));
		if (!first || !second) throw new Error("missing session factories");
		expect(await registered(first)).toEqual(["asker-session-one"]);
		expect(await registered(second)).toEqual(["asker-session-two"]);
		expect(await registered(first)).toEqual(["asker-session-one"]);
		expect(seen).toEqual(["one", "two"]);
	});

	it("leaves session factories out without a session and out of the child set", () => {
		const seen: string[] = [];
		const entries = [sessionEntry("asker", 0, seen)];
		expect(registryInlineExtensions("extensions", undefined, entries)).toEqual([]);
		expect(
			registryInlineExtensions("childExtensions", undefined, entries, session("child")),
		).toEqual([]);
		expect(seen).toEqual([]);
	});

	it("gates session factories on the extension switch at load time", async () => {
		const disabled = new Set(["asker"]);
		const [asker] = registryInlineExtensions(
			"extensions",
			(name) => disabled.has(name),
			[sessionEntry("asker", 0, [])],
			session("a"),
		);
		if (!asker) throw new Error("missing asker");
		expect(await registered(asker)).toEqual([]);
		disabled.clear();
		expect(await registered(asker)).toEqual(["asker-session-a"]);
	});
});

describe("omp tool precedence the registry relies on", () => {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-inline-precedence-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("lets an inline registry factory win a tool name over a user package loaded by path", async () => {
		const packagePath = join(root, "rival.ts");
		writeFileSync(
			packagePath,
			`export default function (pi) {
	pi.registerTool({ name: "shared_tool", label: "rival", description: "rival", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "rival" }] }) });
}
`,
		);
		const [ours] = registryInlineExtensions("extensions", undefined, [
			{
				specifier: "@acme/ours/server",
				extension: {
					name: "ours",
					extensions: [
						(pi: ExtensionAPI) => {
							pi.registerTool({ ...toolNamed("shared_tool"), description: "ours" });
						},
					],
				},
			},
		]);
		if (!ours) throw new Error("missing registry factory");
		const settings = Settings.isolated({});
		const { authStorage, modelRegistry } = await createFauxModelRegistry(settings);
		const model = registerFaux(modelRegistry, createFauxCore({ provider: "precedence-faux" }));
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			settings,
			authStorage,
			modelRegistry,
			model,
			sessionManager: SessionManager.inMemory(root),
			extensions: [ours],
			preloadedExtensionPaths: [packagePath],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});
		try {
			expect(
				session.extensionRunner?.getRegisteredTool("shared_tool")?.definition.description,
			).toBe("ours");
		} finally {
			await session.dispose();
		}
	});
});
