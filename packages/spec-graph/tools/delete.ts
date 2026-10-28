import { rmSync } from "node:fs";
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { errorResult, getIndex, textResult } from "./shared.ts";

const parameters = z.object({
	id: z.string().describe("Id of the spec to delete."),
});

export function registerSpecDelete(pi: ExtensionAPI): void {
	pi.registerTool<typeof parameters, { id: string; path: string } | { error: string }>({
		name: "spec_delete",
		label: "Spec Delete",
		description:
			"Delete a spec file by id. Other specs may still reference it afterward — run spec_validate to find dangling links.",
		loadMode: "essential",
		parameters,
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const index = getIndex(ctx.cwd);
			const path = index.pathForId(params.id);
			if (!path) return errorResult(`No spec with id "${params.id}".`);
			try {
				rmSync(index.absPath(path));
			} catch (err) {
				return errorResult(`Failed to delete ${path}: ${(err as Error).message}`);
			}
			return textResult(`Deleted ${path} (id: ${params.id}).`, { id: params.id, path });
		},
	});
}
