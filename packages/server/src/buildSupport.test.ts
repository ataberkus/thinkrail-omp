import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	collectEnginePiModules,
	ENGINE_COMPILED_EXTERNALS,
	ENGINE_PI_MODULES_SPECIFIER,
	ENGINE_PI_PACKAGES,
	engineBundledBuildConfig,
	engineCompiledBuildConfig,
	engineNativeAddons,
	engineWorkerHostSources,
	renderEnginePiModules,
	resolveBuildRuntimeSources,
} from "./buildSupport";
import { resolveExtensionSkillRoots, serverExtensions } from "./extensions";

test("runtime source manifest covers the launcher artifact surface", () => {
	const sources = resolveBuildRuntimeSources();
	expect(sources.extensions.map((extension) => extension.specifier)).toEqual([
		"pi-spec-graph/index.ts",
		"pi-thinkrail-workflow/index.ts",
		"pi-todos/index.ts",
	]);
	expect(sources.extensions.map((extension) => extension.specifier)).not.toContain(
		expect.stringContaining("visualize"),
	);
	const piPackageSkillRoots = sources.extensions.map((extension) =>
		join(dirname(extension.entry), "skills"),
	);
	expect(sources.skillRoots).toEqual([
		...piPackageSkillRoots,
		join(import.meta.dir, "..", "skills"),
		...serverExtensions.flatMap(resolveExtensionSkillRoots),
	]);
	expect(sources.skillRoots.map((root) => basename(dirname(root)))).toEqual([
		"spec-graph",
		"pi-thinkrail-workflow",
		"pi-todos",
		"server",
	]);
	expect(
		Object.fromEntries(
			Object.entries(sources.ptyLibraries).map(([target, path]) => [target, basename(path)]),
		),
	).toEqual({
		"darwin-arm64": "librust_pty_arm64.dylib",
		"darwin-x64": "librust_pty.dylib",
		"linux-arm64": "librust_pty_arm64.so",
		"linux-x64": "librust_pty.so",
		"win32-x64": "rust_pty.dll",
	});
	expect(basename(sources.trashHelpers.macos)).toBe("macos-trash");
	expect(basename(sources.trashHelpers.windows)).toBe("windows-trash.exe");
});

const codingAgentDir = dirname(
	dirname(realpathSync(Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir))),
);
const ompVirtualModuleScript = join(codingAgentDir, "scripts", "legacy-pi-virtual-module.ts");

test("the engine module registry mirrors omp's own compiled-binary registry", async () => {
	const ompPackages = [
		...readFileSync(ompVirtualModuleScript, "utf8").matchAll(
			/\{ dir: "[^"]+", identifier: "([^"]+)", rootShim: (null|"[^"]+"), rootWildcard: (null|"[^"]+") \}/g,
		),
	].map((match) => match.slice(1));
	expect(
		ENGINE_PI_PACKAGES.map(({ identifier, rootShim, rootWildcard }) => [
			identifier,
			JSON.stringify(rootShim),
			JSON.stringify(rootWildcard),
		]),
	).toEqual(ompPackages);
	const omp = await import(ompVirtualModuleScript);
	expect(ENGINE_PI_MODULES_SPECIFIER).toBe(omp.LEGACY_PI_MODULES_SPECIFIER);
	const entries = collectEnginePiModules();
	expect(renderEnginePiModules(entries)).toBe(omp.__renderLegacyPiVirtualModule(entries));
});

test("the engine module registry serves every surface an external extension imports", () => {
	const entries = collectEnginePiModules();
	const keys = entries.map((entry) => entry.key);
	for (const key of [
		"@oh-my-pi/pi-coding-agent",
		"@oh-my-pi/pi-ai",
		"@oh-my-pi/pi-ai/utils/event-stream",
		"@oh-my-pi/pi-ai/oauth",
		"@oh-my-pi/pi-agent-core",
		"@oh-my-pi/pi-tui",
		"@oh-my-pi/pi-utils",
		"@oh-my-pi/pi-natives",
		"typebox",
	]) {
		expect(keys).toContain(key);
	}
	expect(keys).not.toContain("@oh-my-pi/pi-coding-agent/cli");
	expect(new Set(keys).size).toBe(keys.length);
	expect(entries.find((entry) => entry.key === "@oh-my-pi/pi-coding-agent")?.importSpecifier).toBe(
		join(realpathSync(codingAgentDir), "src", "extensibility", "legacy-pi-coding-agent-shim.ts"),
	);
	for (const entry of entries) expect(existsSync(entry.importSpecifier)).toBe(true);
});

test("the bundled engine build selects omp's bundled extension loader", () => {
	const config = engineBundledBuildConfig();
	expect(config.define["process.env.PI_BUNDLED"]).toBe('"true"');
	expect(config.define).not.toHaveProperty(["process.env.PI_COMPILED"]);
	expect(config.define["process.env.PI_DOCS_EMBED"]?.length).toBeGreaterThan(1000);
	expect(config.external).toEqual([...ENGINE_COMPILED_EXTERNALS]);
	expect(config.plugins.map((plugin) => plugin.name)).toEqual(["thinkrail:engine-pi-modules"]);
	expect(config.files).toEqual({});
});

test("the compiled engine build embeds the host's native addons for omp's loader", async () => {
	const host = { platform: process.platform, arch: process.arch };
	const addons = engineNativeAddons(host);
	expect(addons.length).toBeGreaterThan(0);
	const config = await engineCompiledBuildConfig(host);
	expect(config.define["process.env.PI_COMPILED"]).toBe('"true"');
	const nativesDir = realpathSync(
		join(dirname(Bun.resolveSync("@oh-my-pi/pi-natives", codingAgentDir)), ".."),
	);
	const manifest = config.files[join(nativesDir, "native", "embedded-addon.js")];
	expect(typeof manifest).toBe("string");
	for (const addon of addons) {
		expect(manifest).toContain(JSON.stringify(addon.filename));
		expect(config.files[join(nativesDir, "native", `${addon.filename}.zst`)]).toBeInstanceOf(
			Uint8Array,
		);
	}
}, 120_000);

test("a target without an installed native package fails the build", () => {
	expect(() => engineNativeAddons({ platform: "linux", arch: "riscv64" })).toThrow(
		"@oh-my-pi/pi-natives-linux-riscv64 is not installed",
	);
});

test("the worker host routes engine selectors through omp's own entry", () => {
	const sources = engineWorkerHostSources();
	expect(sources.cli).toBe(join(codingAgentDir, "src", "cli.ts"));
	expect(existsSync(sources.workerHost)).toBe(true);
	expect(readFileSync(sources.workerHost, "utf8")).toContain(
		"export function declareWorkerHostEntry",
	);
});
