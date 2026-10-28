import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [, , specPath] = process.argv;
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const within = (root, candidate) => candidate === root || candidate.startsWith(root + sep);

const fixtureDir = realpathSync(spec.fixtureDir);
const runnerDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
const ompEntry = realpathSync(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent")));
if (runnerDir !== fixtureDir || !within(join(fixtureDir, "node_modules"), ompEntry)) {
	console.error(
		`parity runner must execute from the fixture ${fixtureDir} and load its omp, got ${runnerDir} → ${ompEntry}`,
	);
	process.exit(1);
}
if (process.env.PI_CODING_AGENT_DIR !== spec.agentDir) {
	console.error(`parity runner needs PI_CODING_AGENT_DIR=${spec.agentDir} at spawn`);
	process.exit(1);
}

const omp = await import("@oh-my-pi/pi-coding-agent");
const { stripTerminalSequences } = await import("@oh-my-pi/pi-tui");

const failures = [];
const fail = (message) => failures.push(message);

const settings = await omp.Settings.loadIsolated({ cwd: spec.cwd, agentDir: spec.agentDir });
const paths = await omp.discoverSessionExtensionPaths({}, spec.cwd, settings);
const { extensions, errors } = await omp.loadExtensions(paths, spec.cwd);
for (const error of errors) fail(`extension error at ${error.path}: ${error.error}`);

const pluginDir = realpathSync(spec.pluginDir);
const extension = extensions.find((entry) => within(pluginDir, realpathSync(entry.resolvedPath)));
if (!extension) {
	fail(
		`package ${spec.name} was not discovered from ${pluginDir} (discovered: ${paths.join(", ") || "none"})`,
	);
}

const tools = new Map(extension ? [...extension.tools.entries()] : []);
for (const name of spec.tools) {
	const tool = tools.get(name);
	if (!tool) fail(`tool ${name} not registered (have: ${[...tools.keys()].join(", ") || "none"})`);
	else if (tool.definition.loadMode !== "essential")
		fail(`tool ${name} has loadMode ${tool.definition.loadMode}, expected "essential"`);
}

const { skills } = await omp.discoverSkills(spec.cwd);
const skillNames = skills.map((skill) => skill.name);
for (const name of spec.skills) {
	if (!skillNames.includes(name))
		fail(`skill ${name} not discovered (have: ${skillNames.join(", ") || "none"})`);
}

await omp.initTheme(false);
const fakeTui = { requestRender: () => {}, terminal: { rows: 40, columns: 100 } };
const plain = (lines) => lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");

function scriptedContext(script) {
	if (!script) return { hasUI: false, cwd: spec.cwd };
	const replies = [...(script.replies ?? [])];
	const next = () => {
		if (replies.length === 0) throw new Error("the scripted UI ran out of replies");
		const reply = replies.shift();
		return reply === null ? undefined : reply;
	};
	const ui = {
		select: async (_title, choices) => {
			const reply = next();
			return typeof reply === "number" ? choices[reply] : reply;
		},
		input: async () => next(),
		custom: (factory) =>
			new Promise((resolve, reject) => {
				Promise.resolve(factory(fakeTui, omp.theme, {}, resolve))
					.then((component) => {
						for (const key of script.keys ?? []) component.handleInput(key);
					})
					.catch(reject);
			}),
		notify: () => {},
	};
	return { mode: script.mode, hasUI: true, cwd: spec.cwd, ui };
}

for (const testCase of spec.cases) {
	const tool = tools.get(testCase.tool)?.definition;
	if (!tool) continue;
	const label = `${testCase.tool} ${testCase.name}`;
	let result;
	try {
		result = await tool.execute(
			`parity-${testCase.name}`,
			testCase.args,
			undefined,
			undefined,
			scriptedContext(testCase.ui),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (testCase.expectError) {
			if (!new RegExp(testCase.expectError).test(message)) {
				fail(`${label}: error did not match /${testCase.expectError}/: ${message}`);
			}
		} else {
			fail(`${label}: unexpected error: ${message}`);
		}
		continue;
	}
	if (testCase.expectError) {
		fail(`${label}: expected an error matching /${testCase.expectError}/ but the call succeeded`);
		continue;
	}
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	for (const needle of testCase.expectText ?? []) {
		if (!text.includes(needle)) fail(`${label}: result text lacks ${JSON.stringify(needle)}`);
	}
	if (testCase.expectTerminate !== undefined && result.terminate !== testCase.expectTerminate) {
		fail(`${label}: terminate was ${result.terminate}, expected ${testCase.expectTerminate}`);
	}
	if (testCase.expectRender) {
		if (!tool.renderResult) {
			fail(`${label}: expected a TUI render but the tool has no renderResult`);
			continue;
		}
		const component = tool.renderResult(
			result,
			{ expanded: false, isPartial: false },
			omp.theme,
			testCase.args,
		);
		const rendered = plain(component.render(testCase.expectRender.width ?? 100));
		for (const needle of testCase.expectRender.contains ?? []) {
			if (!rendered.includes(needle)) fail(`${label}: TUI render lacks ${JSON.stringify(needle)}`);
		}
	}
}

const pluginEngineDir = join(realpathSync(dirname(dirname(pluginDir))), "@oh-my-pi");
for (const loaded of Object.keys(createRequire(import.meta.url).cache)) {
	if (within(pluginEngineDir, loaded.split("?")[0] ?? loaded))
		fail(`${spec.name} bound to a plugin-local omp copy instead of the host: ${loaded}`);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(
	`  ✓ ${spec.name}: ${spec.tools.length} tool(s), ${spec.skills.length} skill(s), ${spec.cases.length} case(s) — discovered by omp at ${extension.resolvedPath}`,
);
