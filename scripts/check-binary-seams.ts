#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, sep } from "node:path";
import ts from "typescript";

const RUNTIME_PATH =
	"safe — the specifier is a filesystem path or URL chosen at runtime (user/plugin file on disk), " +
	"which a compiled binary loads from the real filesystem; its @oh-my-pi/* imports are served by the " +
	"build-supplied omp-legacy-pi-modules registry";

const OPAQUE_ALLOWLIST: Record<string, { reason: string; imports: string[] }> = {
	"pi-coding-agent/src/extensibility/plugins/legacy-pi-compat.ts": {
		reason: `${RUNTIME_PATH} (extension entries and their on-disk dependencies; bundled host modules take the BUNDLED_VIRTUAL_SCHEME branch instead)`,
		imports: [
			`\`\${entrySpecifier}?mtime=\${nextLegacyPiLoadTag()}\``,
			"entrySpecifier",
			"toImportSpecifier(resolved)",
		],
	},
	"pi-coding-agent/src/extensibility/hooks/loader.ts": {
		reason: `${RUNTIME_PATH} (hook module paths)`,
		imports: ["resolvedPath"],
	},
	"pi-coding-agent/src/extensibility/custom-commands/loader.ts": {
		reason: `${RUNTIME_PATH} (custom command module paths)`,
		imports: ["commandPath"],
	},
	"pi-coding-agent/src/export/custom-share.ts": {
		reason: `${RUNTIME_PATH} (the agent dir's custom share script)`,
		imports: ["scriptPath"],
	},
	"pi-coding-agent/src/eval/js/shared/local-module-loader.ts": {
		reason: `${RUNTIME_PATH} (imports made by user code run in the JS eval tool)`,
		imports: ["target"],
	},
	"pi-coding-agent/src/eval/js/shared/runtime.ts": {
		reason: `${RUNTIME_PATH} (imports made by user code run in the JS eval tool)`,
		imports: ["target", "target", "target", "target"],
	},
};

const BUILD_SUPPLIED_ALLOWLIST: Record<string, { reason: string; imports: string[] }> = {
	"pi-coding-agent/src/extensibility/plugins/legacy-pi-compat.ts": {
		reason:
			"handled — the compiled binary and the desktop runtime bundle supply it through " +
			"@thinkrail/server/build-support's engine pi-modules plugin",
		imports: ["omp-legacy-pi-modules"],
	},
};

const SKIPPED_DIRS: Record<string, string> = {
	"pi-coding-agent/dist":
		"omp's npm CLI bundle (dist/cli.js, reached only through its `omp` bin) plus type declarations " +
		"and HTML-export assets; the package exports map every import ThinkRail makes to src/",
	"pi-coding-agent/scripts": "omp's own build and benchmark tooling, never imported at runtime",
	"pi-coding-agent/examples": "documentation examples, never imported at runtime",
};

function packageRoot(name: string, from: string): string {
	let dir = dirname(Bun.resolveSync(name, from));
	for (;;) {
		try {
			const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (typeof manifest === "object" && manifest !== null && "name" in manifest) {
				if (manifest.name === name) return dir;
			}
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`cannot locate package root for ${name} from ${from}`);
		dir = parent;
	}
}

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
		else if (/\.(ts|tsx|mts|js|mjs)$/.test(full) && !/\.d\.[mc]?ts$/.test(full)) out.push(full);
	}
	return out;
}

interface DynamicImports {
	readonly opaque: string[];
	readonly literal: string[];
}

function dynamicImportsIn(fileName: string, source: string): DynamicImports {
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		false,
		/\.tsx?$|\.mts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
	);
	const opaque: string[] = [];
	const literal: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const specifier = node.arguments[0];
			if (
				specifier !== undefined &&
				(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))
			) {
				literal.push(specifier.text);
			} else {
				opaque.push(
					specifier ? specifier.getText(sourceFile).replace(/\s+/g, " ").trim() : "<no argument>",
				);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { opaque: opaque.sort(), literal: literal.sort() };
}

function resolvable(specifier: string, fromFile: string): boolean {
	if (isBuiltin(specifier) || specifier === "bun" || specifier.startsWith("bun:")) return true;
	try {
		Bun.resolveSync(specifier, dirname(fromFile));
		return true;
	} catch {
		return false;
	}
}

const repoRoot = join(import.meta.dir, "..");
const roots = new Map<string, string>();
const queue: string[] = [];
const enqueue = (name: string, resolveFrom: string): void => {
	if (roots.has(name)) return;
	roots.set(name, packageRoot(`@oh-my-pi/${name}`, resolveFrom));
	queue.push(name);
};
enqueue("pi-coding-agent", join(repoRoot, "packages", "server"));
for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
	const root = roots.get(next);
	if (root === undefined) continue;
	const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const dependencies =
		typeof manifest === "object" &&
		manifest !== null &&
		"dependencies" in manifest &&
		typeof manifest.dependencies === "object" &&
		manifest.dependencies !== null
			? Object.keys(manifest.dependencies)
			: [];
	for (const dep of dependencies) {
		if (dep.startsWith("@oh-my-pi/")) enqueue(dep.slice("@oh-my-pi/".length), root);
	}
}

const opaqueFound = new Map<string, string[]>();
const unresolvedFound = new Map<string, string[]>();
const usedSkips = new Set<string>();
for (const [name, root] of roots) {
	for (const file of listSourceFiles(root)) {
		const id = `${name}/${file
			.slice(root.length + 1)
			.split(sep)
			.join("/")}`;
		const skipped = Object.keys(SKIPPED_DIRS).find((dir) => id.startsWith(`${dir}/`));
		if (skipped !== undefined) {
			usedSkips.add(skipped);
			continue;
		}
		const source = readFileSync(file, "utf8");
		if (!/\bimport\s*\(/.test(source)) continue;
		const { opaque, literal } = dynamicImportsIn(file, source);
		if (opaque.length > 0) opaqueFound.set(id, opaque);
		const unresolved = literal.filter((specifier) => !resolvable(specifier, file));
		if (unresolved.length > 0) unresolvedFound.set(id, unresolved);
	}
}

function compare(
	found: Map<string, string[]>,
	allowlist: Record<string, { reason: string; imports: string[] }>,
	unexpected: string[],
	stale: string[],
): void {
	for (const id of new Set([...found.keys(), ...Object.keys(allowlist)])) {
		const actual = [...(found.get(id) ?? [])];
		for (const imp of [...(allowlist[id]?.imports ?? [])].sort()) {
			const at = actual.indexOf(imp);
			if (at >= 0) actual.splice(at, 1);
			else stale.push(`${id}: import(${imp})  (${allowlist[id]?.reason})`);
		}
		unexpected.push(...actual.map((imp) => `${id}: import(${imp})`));
	}
}

const unexpectedOpaque: string[] = [];
const unexpectedUnresolved: string[] = [];
const stale: string[] = [];
compare(opaqueFound, OPAQUE_ALLOWLIST, unexpectedOpaque, stale);
compare(unresolvedFound, BUILD_SUPPLIED_ALLOWLIST, unexpectedUnresolved, stale);
for (const [dir, reason] of Object.entries(SKIPPED_DIRS)) {
	if (!usedSkips.has(dir)) stale.push(`${dir}: skipped dir no longer present  (${reason})`);
}

if (unexpectedOpaque.length > 0) {
	console.error(
		"check-binary-seams: NEW bundler-opaque dynamic import(s) in omp — a compiled binary or the desktop bundle cannot resolve a bundled module this way:",
	);
	for (const line of unexpectedOpaque.sort()) console.error(`  - ${line}`);
	console.error(
		"\nVerify each one: supply a build seam (packages/server/src/buildSupport.ts) or a runtime registration in registerBundledRuntime,",
	);
	console.error(
		"or confirm it only receives runtime filesystem paths or node: builtins — then allowlist the occurrence in scripts/check-binary-seams.ts with that evidence.",
	);
}
if (unexpectedUnresolved.length > 0) {
	console.error(
		"check-binary-seams: NEW literal dynamic import(s) in omp that resolve to no installed module — only a build-supplied virtual module can serve them:",
	);
	for (const line of unexpectedUnresolved.sort()) console.error(`  - ${line}`);
	console.error(
		"\nSupply the module from @thinkrail/server/build-support for both artifacts, then allowlist it in scripts/check-binary-seams.ts.",
	);
}
if (stale.length > 0) {
	console.error(
		"check-binary-seams: stale allowlist occurrence(s) — omp moved, removed, or reshaped these imports:",
	);
	for (const line of stale.sort()) console.error(`  - ${line}`);
	console.error(
		"\nRe-verify the seam still covers the replacement, then update the allowlist in scripts/check-binary-seams.ts.",
	);
}
if (unexpectedOpaque.length > 0 || unexpectedUnresolved.length > 0 || stale.length > 0) {
	process.exit(1);
}

const opaqueCount = [...opaqueFound.values()].reduce((n, imports) => n + imports.length, 0);
const suppliedCount = [...unresolvedFound.values()].reduce((n, imports) => n + imports.length, 0);
console.log(
	`check-binary-seams: OK (${opaqueCount} opaque and ${suppliedCount} build-supplied dynamic import occurrences in ${opaqueFound.size + unresolvedFound.size} files across ${roots.size} omp packages, all handled or safe)`,
);
