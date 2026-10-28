import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { registerTodoTools } from "./tools/index.ts";

const TODO_SECTION = "pi-todos";

const TODO_RULE = [
	"This chat has a shared TODO list — your live plan for the conversation, which the user edits too.",
	"A pending loose item already in that list is promoted into its own group when you take it into work, regardless of size.",
	"When the user asks for a plan or new work needs at least three substantive execution steps, read the todos skill, create a concise plan once the task is understood enough to plan, and keep it current.",
].join("\n");

export const TODO_BLOCK = `<${TODO_SECTION}>\n${TODO_RULE}\n</${TODO_SECTION}>`;

const factory: ExtensionFactory = (pi: ExtensionAPI) => {
	registerTodoTools(pi);

	pi.on("before_agent_start", (event) =>
		event.systemPrompt.includes(TODO_BLOCK)
			? undefined
			: { systemPrompt: [...event.systemPrompt, TODO_BLOCK] },
	);
};

export default factory;
