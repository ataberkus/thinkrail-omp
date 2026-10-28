import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { type GraphSlice, graphSlice, LINK_KINDS, SLICE_DIRECTIONS } from "../core/index.ts";
import { errorResult, getIndex, textResult } from "./shared.ts";

const parameters = z.object({
	root: z.string().describe("Id of the node to start from."),
	direction: z
		.enum(SLICE_DIRECTIONS)
		.describe(
			"subtree = down the parent tree; ancestors = up the parent chain; neighbors = across an edge and its reverse.",
		),
	depth: z.number().optional().describe("How many hops to expand (default: 1)."),
	edge: z
		.enum(LINK_KINDS)
		.optional()
		.describe("For direction=neighbors: which edge kind to traverse (default: depends-on)."),
});

export function registerSpecGraph(pi: ExtensionAPI): void {
	pi.registerTool<typeof parameters, GraphSlice | { error: string }>({
		name: "spec_graph",
		label: "Spec Graph",
		description:
			"Return a bounded slice of the spec-graph rooted at a node: `subtree` (down the parent tree), `ancestors` (up to the tree root), or `neighbors` (across a chosen edge and its reverse). Bounded by `depth` (default 1).",
		loadMode: "essential",
		parameters,
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const graph = getIndex(ctx.cwd).graph();
			if (!graph.nodes.has(params.root)) {
				return errorResult(`No spec with id "${params.root}".`);
			}
			const slice = graphSlice(graph, {
				root: params.root,
				direction: params.direction,
				...(params.depth !== undefined ? { depth: params.depth } : {}),
				...(params.edge !== undefined ? { edge: params.edge } : {}),
			});

			const nodeLines = slice.nodes.map(
				(n) => `  ${n.id} [${n.type}]${n.title ? ` — ${n.title}` : ""} (${n.path})`,
			);
			const edgeLines = slice.edges.map((e) => `  ${e.from} --${e.kind}--> ${e.to}`);
			const text = [
				`Slice of "${params.root}" (${params.direction}, depth ${params.depth ?? 1}):`,
				`nodes (${slice.nodes.length}):`,
				...nodeLines,
				`edges (${slice.edges.length}):`,
				...edgeLines,
				slice.missing.length ? `missing targets: ${slice.missing.join(", ")}` : "",
			]
				.filter(Boolean)
				.join("\n");

			return textResult(text, slice);
		},
	});
}
