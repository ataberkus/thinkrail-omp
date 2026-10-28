import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExtensionSkillRoots, serverExtensions } from "./extensions";

export type DesktopRuntimeTarget =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-arm64"
	| "linux-x64"
	| "win32-x64";

export interface BundledExtensionSource {
	readonly specifier: string;
	readonly entry: string;
}

export interface BuildRuntimeSources {
	readonly extensions: readonly BundledExtensionSource[];
	readonly skillRoots: readonly string[];
	readonly ptyLibraries: Readonly<Record<DesktopRuntimeTarget, string>>;
	readonly trashHelpers: {
		readonly macos: string;
		readonly windows: string;
	};
}

const require = createRequire(import.meta.url);

function requiredPath(path: string): string {
	if (!existsSync(path)) throw new Error(`required runtime source is missing: ${path}`);
	return path;
}

export function resolveBuildRuntimeSources(): BuildRuntimeSources {
	const piPackages = [
		{ specifier: "pi-spec-graph/index.ts", skills: true },
		{ specifier: "pi-thinkrail-workflow/index.ts", skills: true },
		{ specifier: "pi-todos/index.ts", skills: true },
	].map(({ specifier, skills }) => ({ specifier, entry: require.resolve(specifier), skills }));
	const extensions = piPackages.map(({ specifier, entry }) => ({ specifier, entry }));
	const skillRoots = [
		...piPackages
			.filter((pkg) => pkg.skills)
			.map((pkg) => requiredPath(join(dirname(pkg.entry), "skills"))),
		requiredPath(fileURLToPath(new URL("../skills", import.meta.url))),
		...serverExtensions.flatMap(resolveExtensionSkillRoots).map(requiredPath),
	];
	const ptyRelease = join(
		dirname(require.resolve("bun-pty")),
		"..",
		"rust-pty",
		"target",
		"release",
	);
	const trashLib = join(dirname(require.resolve("trash")), "lib");
	return {
		extensions,
		skillRoots,
		ptyLibraries: {
			"darwin-arm64": requiredPath(join(ptyRelease, "librust_pty_arm64.dylib")),
			"darwin-x64": requiredPath(join(ptyRelease, "librust_pty.dylib")),
			"linux-arm64": requiredPath(join(ptyRelease, "librust_pty_arm64.so")),
			"linux-x64": requiredPath(join(ptyRelease, "librust_pty.so")),
			"win32-x64": requiredPath(join(ptyRelease, "rust_pty.dll")),
		},
		trashHelpers: {
			macos: requiredPath(join(trashLib, "macos-trash")),
			windows: requiredPath(join(trashLib, "windows-trash.exe")),
		},
	};
}

export interface EngineTarget {
	readonly platform: string;
	readonly arch: string;
}

export interface EngineNativeAddon {
	readonly variant: "modern" | "baseline" | "default";
	readonly filename: string;
	readonly path: string;
}

export interface EngineBuildConfig {
	readonly plugins: Bun.BunPlugin[];
	readonly define: Record<string, string>;
	readonly external: string[];
	readonly files: Record<string, string | Uint8Array>;
}

export interface EngineWorkerHostSources {
	readonly cli: string;
	readonly workerHost: string;
}

export interface EnginePiModuleEntry {
	readonly key: string;
	readonly binding: string;
	readonly importSpecifier: string;
}

export interface EnginePiPackage {
	readonly name: string;
	readonly identifier: string;
	readonly rootShim: string | null;
	readonly rootWildcard: "flat" | "nested" | null;
}

export const ENGINE_PI_MODULES_SPECIFIER = "omp-legacy-pi-modules";
export const ENGINE_COMPILED_EXTERNALS: readonly string[] = ["fastembed", "onnxruntime-node"];
export const ENGINE_PI_PACKAGES: readonly EnginePiPackage[] = [
	{
		name: "@oh-my-pi/pi-agent-core",
		identifier: "PiAgentCore",
		rootShim: null,
		rootWildcard: null,
	},
	{
		name: "@oh-my-pi/pi-ai",
		identifier: "PiAi",
		rootShim: "legacy-pi-ai-shim.ts",
		rootWildcard: null,
	},
	{ name: "@oh-my-pi/pi-catalog", identifier: "PiCatalog", rootShim: null, rootWildcard: "flat" },
	{
		name: "@oh-my-pi/pi-coding-agent",
		identifier: "PiCodingAgent",
		rootShim: "legacy-pi-coding-agent-shim.ts",
		rootWildcard: null,
	},
	{ name: "@oh-my-pi/pi-natives", identifier: "PiNatives", rootShim: null, rootWildcard: null },
	{
		name: "@oh-my-pi/pi-tui",
		identifier: "PiTui",
		rootShim: "legacy-pi-tui-shim.ts",
		rootWildcard: "nested",
	},
	{ name: "@oh-my-pi/pi-utils", identifier: "PiUtils", rootShim: null, rootWildcard: null },
];

const ENGINE_TYPEBOX_KEY = "typebox";
const ENGINE_TYPEBOX_SHIM = "legacy-typebox.ts";
const ENGINE_PI_MODULES_NAMESPACE = "thinkrail-engine-pi-modules";
const MAIN_THREAD_UNSAFE_BASENAMES = new Set(["worker-entry"]);
const NATIVE_ADDON_ZSTD_LEVEL = 9;
const NATIVE_VERSION_STAMP_MAGIC = "PI_NATIVES_VERSION_STAMP:";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(root: string): Record<string, unknown> {
	const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (!isRecord(manifest)) throw new Error(`package manifest is not an object: ${root}`);
	return manifest;
}

function packageRoot(name: string, from: string): string {
	let dir = dirname(realpathSync(Bun.resolveSync(name, from)));
	for (;;) {
		if (existsSync(join(dir, "package.json")) && readManifest(dir).name === name) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`cannot locate the package root of ${name} from ${from}`);
		dir = parent;
	}
}

function codingAgentRoot(): string {
	return packageRoot("@oh-my-pi/pi-coding-agent", import.meta.dir);
}

function engineShim(file: string): string {
	return requiredPath(join(codingAgentRoot(), "src", "extensibility", file));
}

function bindingFor(identifier: string, subpath: string): string {
	const segments = subpath
		.split("/")
		.filter(Boolean)
		.map((segment) =>
			segment
				.split(/[^a-zA-Z0-9]+/)
				.filter(Boolean)
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(""),
		);
	return `bundled${identifier}${segments.join("")}`;
}

function isSafeWildcardBasename(basename: string): boolean {
	if (!basename || basename.startsWith(".") || basename.startsWith("_")) return false;
	if (MAIN_THREAD_UNSAFE_BASENAMES.has(basename)) return false;
	return !/\.(test|spec|d|d\.json|generated|bench)$/.test(basename);
}

function exportImportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.import === "string") return value.import;
	return null;
}

export function collectEnginePiModules(): EnginePiModuleEntry[] {
	const agentRoot = codingAgentRoot();
	const entries: EnginePiModuleEntry[] = [];
	const keys = new Set<string>();
	const bindings = new Set<string>();
	const add = (key: string, binding: string, importSpecifier: string): void => {
		if (keys.has(key)) return;
		if (bindings.has(binding))
			throw new Error(`duplicate engine module binding ${binding} for ${key}`);
		keys.add(key);
		bindings.add(binding);
		entries.push({ key, binding, importSpecifier });
	};
	const resolveKey = (key: string): string => realpathSync(Bun.resolveSync(key, agentRoot));

	for (const pkg of ENGINE_PI_PACKAGES) {
		const root =
			pkg.name === "@oh-my-pi/pi-coding-agent" ? agentRoot : packageRoot(pkg.name, agentRoot);
		const exportsField = readManifest(root).exports;
		const exportMap = isRecord(exportsField) ? exportsField : {};
		add(
			pkg.name,
			`bundled${pkg.identifier}`,
			pkg.rootShim ? engineShim(pkg.rootShim) : resolveKey(pkg.name),
		);
		for (const exportKey of Object.keys(exportMap)) {
			if (!exportKey.startsWith("./") || exportKey === "." || exportKey.includes("*")) continue;
			const subpath = exportKey.slice(2);
			const key = `${pkg.name}/${subpath}`;
			add(key, bindingFor(pkg.identifier, subpath), resolveKey(key));
		}
		for (const exportKey of Object.keys(exportMap)) {
			if (!exportKey.startsWith("./") || exportKey === "." || !exportKey.includes("*")) continue;
			const source = exportImportTarget(exportMap[exportKey]);
			if (!source) continue;
			const exportStar = exportKey.indexOf("*");
			const sourceStar = source.indexOf("*");
			if (sourceStar === -1 || !source.startsWith("./")) continue;
			if (
				exportKey.indexOf("*", exportStar + 1) !== -1 ||
				source.indexOf("*", sourceStar + 1) !== -1
			)
				continue;
			const exportPrefix = exportKey.slice(2, exportStar);
			const exportSuffix = exportKey.slice(exportStar + 1);
			const sourcePrefix = source.slice(2, sourceStar);
			const sourceSuffix = source.slice(sourceStar + 1);
			if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(sourceSuffix)) continue;
			const rootWildcard = exportPrefix === "" || exportPrefix === "/";
			if (rootWildcard && (exportKey !== "./*" || !pkg.rootWildcard)) continue;
			const sourceDir = join(root, sourcePrefix);
			if (!existsSync(sourceDir)) continue;
			const matches = [
				...new Bun.Glob(`**/*${sourceSuffix}`).scanSync({ cwd: sourceDir, onlyFiles: true }),
			]
				.map((match) => match.split("\\").join("/"))
				.sort();
			for (const match of matches) {
				if (rootWildcard && pkg.rootWildcard === "flat" && match.includes("/")) continue;
				const segments = match.slice(0, match.length - sourceSuffix.length).split("/");
				if (segments.some((segment) => segment.startsWith(".") || segment.startsWith("_")))
					continue;
				if (!isSafeWildcardBasename(segments.at(-1) ?? "")) continue;
				const subpath = `${exportPrefix}${segments.join("/")}${exportSuffix}`;
				const key = `${pkg.name}/${subpath}`;
				add(key, bindingFor(pkg.identifier, subpath), realpathSync(join(sourceDir, match)));
			}
		}
	}
	add(ENGINE_TYPEBOX_KEY, "bundledTypeBoxShim", engineShim(ENGINE_TYPEBOX_SHIM));
	return entries;
}

export function renderEnginePiModules(entries: readonly EnginePiModuleEntry[]): string {
	const loaders = entries.map(
		(entry) => `const ${entry.binding} = () => import(${JSON.stringify(entry.importSpecifier)});`,
	);
	const modules = entries.map((entry) => `\t${JSON.stringify(entry.key)}: ${entry.binding},`);
	return [...loaders, "", "export const BUNDLED_PI_MODULE_LOADERS = {", ...modules, "};", ""].join(
		"\n",
	);
}

function enginePiModulesPlugin(): Bun.BunPlugin {
	const source = renderEnginePiModules(collectEnginePiModules());
	return {
		name: "thinkrail:engine-pi-modules",
		setup(build) {
			build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
				path: ENGINE_PI_MODULES_SPECIFIER,
				namespace: ENGINE_PI_MODULES_NAMESPACE,
			}));
			build.onLoad({ filter: /.*/, namespace: ENGINE_PI_MODULES_NAMESPACE }, () => ({
				contents: source,
				loader: "ts",
			}));
		},
	};
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array, accept: (end: number) => boolean) {
	const buffer = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
	for (let at = buffer.indexOf(needle); at !== -1; at = buffer.indexOf(needle, at + 1)) {
		if (accept(at + needle.length)) return true;
	}
	return false;
}

function carriesNativeRelease(bytes: Uint8Array, version: string): boolean {
	const stamp = Buffer.from(`${NATIVE_VERSION_STAMP_MAGIC}${version}\0`, "utf8");
	if (containsBytes(bytes, stamp, () => true)) return true;
	const sentinel = Buffer.from(`__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`, "utf8");
	return containsBytes(
		bytes,
		sentinel,
		(end) => !/[A-Za-z0-9_]/.test(String.fromCharCode(bytes[end] ?? 0)),
	);
}

function nativesRoot(): string {
	return packageRoot("@oh-my-pi/pi-natives", codingAgentRoot());
}

export function engineNativeAddons(target: EngineTarget): EngineNativeAddon[] {
	const tag = `${target.platform}-${target.arch}`;
	const natives = nativesRoot();
	const version = readManifest(natives).version;
	if (typeof version !== "string")
		throw new Error(`@oh-my-pi/pi-natives has no version: ${natives}`);
	let leaf: string;
	try {
		leaf = packageRoot(`@oh-my-pi/pi-natives-${tag}`, natives);
	} catch (error) {
		throw new Error(
			`@oh-my-pi/pi-natives-${tag} is not installed; build the ${tag} artifact on a ${tag} host`,
			{ cause: error },
		);
	}
	const candidates: { variant: EngineNativeAddon["variant"]; filename: string }[] =
		target.arch === "x64"
			? [
					{ variant: "modern", filename: `pi_natives.${tag}-modern.node` },
					{ variant: "baseline", filename: `pi_natives.${tag}-baseline.node` },
				]
			: [{ variant: "default", filename: `pi_natives.${tag}.node` }];
	const addons = candidates
		.map((candidate) => ({ ...candidate, path: join(leaf, candidate.filename) }))
		.filter((addon) => existsSync(addon.path));
	if (addons.length === 0) {
		throw new Error(`no native addon for ${tag} in ${leaf}: expected ${candidates[0]?.filename}`);
	}
	for (const addon of addons) {
		if (!carriesNativeRelease(readFileSync(addon.path), version)) {
			throw new Error(`${addon.path} is not the @oh-my-pi/pi-natives@${version} release`);
		}
	}
	return addons;
}

async function embeddedNativeAddonFiles(
	target: EngineTarget,
): Promise<Record<string, string | Uint8Array>> {
	const addons = engineNativeAddons(target);
	const natives = nativesRoot();
	const version = readManifest(natives).version;
	const nativeDir = realpathSync(join(natives, "native"));
	const frames = await Promise.all(
		addons.map(async (addon) =>
			Bun.zstdCompress(readFileSync(addon.path), { level: NATIVE_ADDON_ZSTD_LEVEL }),
		),
	);
	const files: Record<string, string | Uint8Array> = {};
	addons.forEach((addon, index) => {
		const frame = frames[index];
		if (frame) files[join(nativeDir, `${addon.filename}.zst`)] = frame;
	});
	files[join(nativeDir, "embedded-addon.js")] = `${addons
		.map(
			(addon, index) =>
				`import zstdPath${index} from ${JSON.stringify(`./${addon.filename}.zst`)} with { type: "file" };`,
		)
		.join("\n")}
export const embeddedAddon = {
	platformTag: ${JSON.stringify(`${target.platform}-${target.arch}`)},
	version: ${JSON.stringify(version)},
	files: [
${addons
	.map((addon, index) => {
		const size = Bun.file(addon.path).size;
		return `\t\t{ variant: ${JSON.stringify(addon.variant)}, filename: ${JSON.stringify(addon.filename)}, size: ${size}, zstdPath: zstdPath${index} },`;
	})
	.join("\n")}
	],
};
`;
	return files;
}

function engineDefines(): Record<string, string> {
	const agentRoot = codingAgentRoot();
	const define: Record<string, string> = {
		"process.env.PI_DOCS_EMBED": JSON.stringify(
			readFileSync(requiredPath(join(agentRoot, "dist", "docs-index.generated.txt")), "utf8"),
		),
	};
	let transformersVersion: unknown;
	try {
		transformersVersion = readManifest(packageRoot("@huggingface/transformers", agentRoot)).version;
	} catch {
		transformersVersion = undefined;
	}
	if (typeof transformersVersion === "string") {
		define["process.env.PI_TINY_TRANSFORMERS_VERSION"] = JSON.stringify(transformersVersion);
	}
	return define;
}

export async function engineCompiledBuildConfig(target: EngineTarget): Promise<EngineBuildConfig> {
	return {
		plugins: [enginePiModulesPlugin()],
		define: { ...engineDefines(), "process.env.PI_COMPILED": JSON.stringify("true") },
		external: [...ENGINE_COMPILED_EXTERNALS],
		files: await embeddedNativeAddonFiles(target),
	};
}

export function engineBundledBuildConfig(): EngineBuildConfig {
	return {
		plugins: [enginePiModulesPlugin()],
		define: { ...engineDefines(), "process.env.PI_BUNDLED": JSON.stringify("true") },
		external: [...ENGINE_COMPILED_EXTERNALS],
		files: {},
	};
}

export function engineWorkerHostSources(): EngineWorkerHostSources {
	const agentRoot = codingAgentRoot();
	return {
		cli: requiredPath(join(agentRoot, "src", "cli.ts")),
		workerHost: realpathSync(Bun.resolveSync("@oh-my-pi/pi-utils/worker-host", agentRoot)),
	};
}
