import { writeFileSync } from "node:fs";
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { FIELDS, type FrontmatterEdit, updateFrontmatterText } from "../core/index.ts";
import { errorResult, getIndex, textResult } from "./shared.ts";

const listGroup = z.object({
	[FIELDS.dependsOn]: z.array(z.string()).optional(),
	[FIELDS.references]: z.array(z.string()).optional(),
	[FIELDS.implements]: z.array(z.string()).optional(),
	[FIELDS.covers]: z.array(z.string()).optional(),
	[FIELDS.tags]: z.array(z.string()).optional(),
});

const parameters = z.object({
	id: z.string().describe("Id of the spec to update."),
	set: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			"Scalar frontmatter fields to set/overwrite (e.g. title, status, parent). For list fields (depends-on/references/implements/covers/tags) use addList/removeList.",
		),
	remove: z.array(z.string()).optional().describe("Frontmatter field names to remove entirely."),
	addList: listGroup.optional(),
	removeList: listGroup.optional(),
});

export function registerSpecUpdate(pi: ExtensionAPI): void {
	pi.registerTool<typeof parameters, { id: string; path: string } | { error: string }>({
		name: "spec_update",
		label: "Spec Update",
		description:
			"Edit a spec's frontmatter only (never its prose): set/overwrite scalar fields, remove fields, and add/remove entries in the list fields (depends-on/references/implements/covers/tags). Comments and any non-dialect fields are preserved. Prose is edited with the write/edit tools.",
		loadMode: "essential",
		parameters,
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const index = getIndex(ctx.cwd);
			const record = index.recordForId(params.id);
			if (!record) return errorResult(`No spec with id "${params.id}".`);

			const { abs, rel: path, content: cachedText } = record;
			const edit: FrontmatterEdit = {
				set: params.set,
				remove: params.remove,
				addList: params.addList,
				removeList: params.removeList,
			};
			const result = updateFrontmatterText(cachedText, edit);
			if ("error" in result) return errorResult(result.error);
			try {
				writeFileSync(abs, result.content, "utf8");
			} catch (err) {
				return errorResult(`Failed to write ${path}: ${(err as Error).message}`);
			}
			return textResult(`Updated frontmatter of ${path} (id: ${params.id}).`, {
				id: params.id,
				path,
			});
		},
	});
}
