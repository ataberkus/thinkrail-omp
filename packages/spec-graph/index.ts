import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { registerSpecTools } from "./tools/index.ts";

const SPEC_SECTION = "pi-spec-graph";

const SPEC_RULE = [
	"Specs are this project's ground truth.",
	"- Consult the relevant spec when work is governed by or may alter a documented boundary, contract, invariant, behavior, or architecture decision; localized work need not read unrelated specs.",
	"- Treat applicable decisions and contracts as authoritative; reconcile contradictions instead of diverging.",
	"- When a change alters a boundary, contract, invariant, or decision, update the owning spec as part of that change.",
].join("\n");

export const SPEC_BLOCK = `<${SPEC_SECTION}>\n${SPEC_RULE}\n</${SPEC_SECTION}>`;

const factory: ExtensionFactory = (pi: ExtensionAPI) => {
	registerSpecTools(pi);

	pi.on("before_agent_start", (event) =>
		event.systemPrompt.includes(SPEC_BLOCK)
			? undefined
			: { systemPrompt: [...event.systemPrompt, SPEC_BLOCK] },
	);
};

export default factory;
