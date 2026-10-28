import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { errorResult, storeFor, textResult } from "./shared.ts";

const parameters = z.object({
	id: z.string().describe("Id of the item to remove."),
});

export function registerTodoRemove(pi: ExtensionAPI): void {
	pi.registerTool<typeof parameters, { id: string } | { error: string }>({
		name: "todo_remove",
		label: "Todo Remove",
		description:
			"Delete an item from the list by id. Rarely needed: a finished item is marked done (todo_update), not removed — done items stay as the user's history. Remove only when the user explicitly asks to drop an item; to take a loose item into work, use todo_promote.",
		loadMode: "essential",
		parameters,
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const removed = storeFor(ctx).remove(params.id);
			if (!removed) return errorResult(`No TODO with id "${params.id}".`);
			return textResult(`Removed ${params.id}.`, { id: params.id });
		},
	});
}
