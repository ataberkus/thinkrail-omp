import { engineBundledBuildConfig } from "@thinkrail/server/build-support";

const engine = engineBundledBuildConfig();
const result = await Bun.build({
	entrypoints: ["src/index.ts"],
	outdir: "dist",
	target: "bun",
	plugins: engine.plugins,
	define: engine.define,
	external: engine.external,
	files: engine.files,
	throw: false,
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
