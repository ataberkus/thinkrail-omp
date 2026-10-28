import { z } from "@oh-my-pi/pi-coding-agent";

const ComparisonOptionSchema = z.object({
	name: z.string().describe("Short label for this option."),
	description: z.string().describe("One or two sentences describing the option.").optional(),
	pros: z.array(z.string()).describe("Advantages of this option.").optional(),
	cons: z.array(z.string()).describe("Drawbacks of this option.").optional(),
	recommended: z
		.boolean()
		.describe("Set true on the single option you endorse; it is highlighted.")
		.optional(),
	mermaid: z.string().describe("Optional raw mermaid diagram illustrating this option.").optional(),
});

export const VisualizeSchema = z.object({
	type: z
		.enum(["diagram", "comparison", "file"])
		.describe(
			"Which visualization to render. 'diagram' needs `mermaid`; 'comparison' needs `options`; 'file' needs `path`.",
		),
	title: z.string().describe("Optional heading shown above the visualization.").optional(),
	mermaid: z
		.string()
		.describe(
			"Required when type='diagram'. Raw mermaid source of any kind (flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, …).",
		)
		.optional(),
	options: z
		.array(ComparisonOptionSchema)
		.describe("Required when type='comparison'. The alternatives being compared.")
		.optional(),
	path: z
		.string()
		.describe(
			"Required when type='file'. Workspace-relative path of an existing file to show rendered by its type (HTML, Markdown, SVG, CSV, JSON, notebook, image, PDF, or code).",
		)
		.optional(),
	before: z
		.string()
		.describe(
			"Optional with type='file'. Workspace-relative path of the previous version; the file is then shown as a before/after diff.",
		)
		.optional(),
});

export type VisualizeParams = z.infer<typeof VisualizeSchema>;
export type ComparisonOption = z.infer<typeof ComparisonOptionSchema>;
