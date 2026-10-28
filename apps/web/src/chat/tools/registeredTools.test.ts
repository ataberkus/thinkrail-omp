import { describe, expect, it } from "bun:test";
import type { ToolRenderProps } from "@thinkrail/extension-api/web";
import { currentTranslator } from "@thinkrail/locales/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerWebExtensions } from "@/extensions";
import { DefaultToolRenderer, getToolRenderer, getToolSummary } from "../toolRegistry";
import "./register";
import { specToolPaths, splitKnownPathReferences } from "./SpecToolCard";

registerWebExtensions();

const INTENTIONAL_TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
	"find",
	"ast_grep",
	"ast_edit",
	"web_search",
	"visualize",
	"spec_grep",
	"spec_get",
	"spec_graph",
	"spec_create",
	"spec_update",
	"spec_delete",
	"spec_validate",
	"ask_user_question",
	"resolve_comment",
	"request_review",
	"tool_search",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
	"mcp__any_server__any_tool",
] as const;

function props(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
): ToolRenderProps & { onOpenFile: (path: string) => void } {
	return {
		toolCallId: `${toolName}-call`,
		toolName,
		args,
		result,
		status: "done",
		workspaceRoot: "/repo",
		streaming: false,
		onOpenFile: () => {},
	};
}

function renderTool(toolName: string, args: Record<string, unknown>, result: unknown): string {
	return renderToStaticMarkup(
		createElement(getToolRenderer(toolName), props(toolName, args, result)),
	);
}

describe("intentional bundled tool renderers", () => {
	it("extracts paths only from each spec tool's known structured result fields", () => {
		const cases: Array<[string, Record<string, unknown>, unknown, string[]]> = [
			[
				"spec_grep",
				{},
				{ details: { matches: [{ path: "grep/SPEC.md" }, { path: 42 }] } },
				["grep/SPEC.md"],
			],
			[
				"spec_get",
				{},
				{
					details: {
						path: "get/SPEC.md",
						links: [{ path: "forward/SPEC.md" }, { path: null }],
						reverseLinks: [{ path: "reverse/SPEC.md" }],
					},
				},
				["get/SPEC.md", "forward/SPEC.md", "reverse/SPEC.md"],
			],
			["spec_graph", {}, { details: { nodes: [{ path: "graph/SPEC.md" }] } }, ["graph/SPEC.md"]],
			[
				"spec_create",
				{ path: "create/SPEC.md" },
				{ details: { path: "create/SPEC.md" } },
				["create/SPEC.md"],
			],
			["spec_update", {}, { details: { path: "update/SPEC.md" } }, ["update/SPEC.md"]],
			["spec_delete", {}, { details: { path: "deleted/SPEC.md" } }, []],
			[
				"spec_validate",
				{},
				{
					details: {
						duplicateIds: [{ paths: ["one/SPEC.md", "two/SPEC.md"] }],
						danglingLinks: [{ fromPath: "source/SPEC.md" }],
					},
				},
				["one/SPEC.md", "two/SPEC.md", "source/SPEC.md"],
			],
		];

		for (const [toolName, args, result, expected] of cases) {
			expect(specToolPaths(toolName, args, result)).toEqual(expected);
		}
	});

	it("segments exact known path strings without letting a shorter path split a longer one", () => {
		const text = "root SPEC.md; child module-a/SPEC.md; done";
		const segments = splitKnownPathReferences(text, ["SPEC.md", "module-a/SPEC.md"]);

		expect(segments.map((segment) => segment.path).filter(Boolean)).toEqual([
			"SPEC.md",
			"module-a/SPEC.md",
		]);
		expect(segments.map((segment) => segment.text).join("")).toBe(text);
	});

	it("does not link a known path as a suffix inside another path", () => {
		const text = "foreign /tmp/SPEC.md; local SPEC.md:12; backup SPEC.md.bak; nested other/SPEC.md";
		const segments = splitKnownPathReferences(text, ["SPEC.md"]);

		expect(segments.map((segment) => segment.path).filter(Boolean)).toEqual(["SPEC.md"]);
		expect(segments.map((segment) => segment.text).join("")).toBe(text);
	});

	it("registers every non-TODO tool exposed by a normal session", () => {
		for (const toolName of INTENTIONAL_TOOLS) {
			expect(getToolRenderer(toolName)).not.toBe(DefaultToolRenderer);
		}
	});

	it("leaves the five TODO tools on their plan-owned fallback receipts", () => {
		for (const toolName of ["todo_list", "todo_add", "todo_update", "todo_remove", "todo_write"]) {
			expect(getToolRenderer(toolName)).toBe(DefaultToolRenderer);
		}
	});

	it("renders only structured in-worktree spec_get paths as exact preview links", () => {
		const html = renderTool(
			"spec_get",
			{ id: "sample-root" },
			{
				content: [
					{
						type: "text",
						text: [
							"sample-root [goal-and-requirements] — Sample Project",
							"path: SPEC.md",
							"links:",
							"  parent -> sample-parent (module-a/SPEC.md)",
							"  references -> foreign (/tmp/outside.md)",
						].join("\n"),
					},
				],
				details: {
					path: "SPEC.md",
					links: [{ path: "module-a/SPEC.md" }, { path: "/tmp/outside.md" }],
					reverseLinks: [],
				},
			},
		);

		expect(html).not.toContain("&quot;id&quot;");
		expect(html.match(/data-testid="tool-file-link"/g)).toHaveLength(2);
		expect(html).toContain('data-path="SPEC.md"');
		expect(html).toContain('data-path="module-a/SPEC.md"');
		expect(html).toContain("/tmp/outside.md");
		expect(html).not.toContain('data-path="/tmp/outside.md"');
	});

	it("keeps a failed spec mutation path inert", () => {
		const rendererProps = props(
			"spec_create",
			{ path: "missing/SPEC.md", id: "missing" },
			{
				content: [{ type: "text", text: "Error: failed to create missing/SPEC.md" }],
				details: { path: "missing/SPEC.md", error: "failed" },
			},
		);
		const html = renderToStaticMarkup(
			createElement(getToolRenderer("spec_create"), { ...rendererProps, status: "error" }),
		);

		expect(html).toContain("missing/SPEC.md");
		expect(html).not.toContain('data-testid="tool-file-link"');
	});

	it("keeps a successful spec_delete path inert", () => {
		const html = renderTool(
			"spec_delete",
			{ id: "removed" },
			{
				content: [{ type: "text", text: "Deleted removed/SPEC.md (id: removed)." }],
				details: { id: "removed", path: "removed/SPEC.md" },
			},
		);

		expect(html).toContain("removed/SPEC.md");
		expect(html).not.toContain('data-testid="tool-file-link"');
	});

	it("summarizes the search query, the read URL, and each search tool's pattern", () => {
		const summary = (toolName: string, args: Record<string, unknown>, result: unknown = null) =>
			getToolSummary(currentTranslator(), toolName, props(toolName, args, result));

		expect(summary("web_search", { query: "first query", recency: "week" })).toBe("first query");
		expect(summary("read", { path: "https://example.com/one:1-20" })).toBe(
			"https://example.com/one:1-20",
		);
		expect(summary("read", { path: "/repo/src/app.ts:50-80" })).toBe("src/app.ts:50-80");
		expect(summary("grep", { pattern: "TODO", path: "src" })).toBe("TODO");
		expect(summary("glob", { path: "src/**/*.ts" })).toBe("src/**/*.ts");
		expect(summary("find", { query: "where sessions resume", grep_keywords: [] })).toBe(
			"where sessions resume",
		);
		expect(summary("ast_grep", { pat: "console.log($A)" })).toBe("console.log($A)");
		expect(summary("ast_edit", { ops: [{ pat: "a($B)", out: "b($B)" }], paths: ["src"] })).toBe(
			"a($B)",
		);
		expect(
			summary(
				"edit",
				{ input: "[src/a.ts#1a2b]\nPUT 1.=1:\n+x" },
				{ details: { path: "/repo/src/a.ts", diff: "+1|x" } },
			),
		).toBe("src/a.ts");
	});

	it("treats only HTTP read targets as external links and gates local targets as files", () => {
		const result = { content: [{ type: "text", text: "Fetched." }] };
		const external = renderTool("read", { path: "https://www.example.com/docs" }, result);
		const local = renderTool("read", { path: "module-a/SPEC.md" }, result);
		const foreign = renderTool("read", { path: "/tmp/video.mp4" }, result);

		expect(external).toContain('href="https://www.example.com/docs"');
		expect(external).toContain(">example.com</a>");
		expect(local).toContain('data-path="module-a/SPEC.md"');
		expect(foreign).not.toContain('data-testid="tool-file-link"');
		expect(foreign).toContain("/tmp/video.mp4");
	});

	it("renders search answers and URL reads as Markdown with safe external links", () => {
		const search = renderTool(
			"web_search",
			{ query: "preview tabs" },
			{
				content: [{ type: "text", text: "flattened for the model" }],
				details: {
					response: {
						provider: "exa",
						answer: "# Answer\n\nRead the [source](https://example.com/source).",
						sources: [
							{ title: "Docs", url: "https://example.com/docs", snippet: "Preview tabs" },
							{ title: "Unsafe", url: "javascript:alert(1)" },
						],
						citations: [{ title: "Cited", url: "https://example.com/cited" }],
					},
				},
			},
		);
		expect(search).toContain("<h1>Answer</h1>");
		expect(search).toContain('href="https://example.com/source"');
		expect(search).toContain('href="https://example.com/docs"');
		expect(search).toContain('href="https://example.com/cited"');
		expect(search).toContain("via exa");
		expect(search).not.toContain('href="javascript:');
		expect(search).not.toContain("flattened for the model");

		const plain = renderTool(
			"web_search",
			{ query: "preview tabs" },
			{ content: [{ type: "text", text: "# Answer\n\n[source](https://example.com/source)" }] },
		);
		expect(plain).toContain("<h1>Answer</h1>");
		expect(plain).toContain('href="https://example.com/source"');

		const page = renderTool(
			"read",
			{ path: "https://example.com/page" },
			{
				content: [
					{
						type: "text",
						text: "URL: https://example.com/page\nContent-Type: text/html\nMethod: GET\n\n---\n\n# Page\n\nSee [docs](https://example.com/docs).",
					},
				],
				details: {
					kind: "url",
					url: "https://example.com/page",
					finalUrl: "https://example.com/page",
					contentType: "text/html",
					method: "GET",
					truncated: false,
					notes: [],
				},
			},
		);
		expect(page).toContain("<h1>Page</h1>");
		expect(page).toContain('href="https://example.com/docs"');
		expect(page).not.toContain("Content-Type");
	});

	it("shows a failed web search as an error even when the tool reports it as text", () => {
		const html = renderTool(
			"web_search",
			{ query: "q" },
			{
				content: [{ type: "text", text: "Error: No web search model configured." }],
				details: {
					response: { provider: "none", sources: [] },
					error: "No web search model configured.",
				},
			},
		);
		expect(html).toContain("text-feedback-error");
		expect(html).toContain("No web search model configured.");
	});

	it("shows where a shell command ran and the job a backgrounded command started", () => {
		const html = renderTool(
			"bash",
			{ command: "bun test", cwd: "/repo/packages/web", async: true },
			{
				content: [{ type: "text", text: "Started background job bash-1" }],
				details: { async: { state: "running", jobId: "bash-1", type: "bash" } },
			},
		);
		expect(html).toContain("in packages/web");
		expect(html).toContain("background job bash-1");
	});

	it("renders search tool output from its display text with a result count", () => {
		const html = renderTool(
			"grep",
			{ pattern: "TODO", path: "/repo/src" },
			{
				content: [{ type: "text", text: "a.ts\n12#ab:// TODO" }],
				details: { matchCount: 2, fileCount: 1, displayContent: "a.ts\n│12* // TODO" },
			},
		);
		expect(html).toContain("2 matches");
		expect(html).toContain("│12* // TODO");
		expect(html).not.toContain("12#ab");
		expect(html).toContain(">src</span>");
	});
});
