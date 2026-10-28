import { describe, expect, it } from "bun:test";
import type { ToolRenderProps } from "@thinkrail/extension-api/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditCard } from "./EditCard";
import { ReadCard } from "./ReadCard";
import { WriteCard } from "./WriteCard";

const result = { content: [{ type: "text", text: "ok" }] };

function props(
	toolName: string,
	path: string,
	status: ToolRenderProps["status"] = "done",
): ToolRenderProps & { onOpenFile: (path: string) => void } {
	return {
		toolCallId: `${toolName}-call`,
		toolName,
		args: { path, content: "hello", oldText: "old", newText: "new" },
		result,
		status,
		workspaceRoot: "/repo",
		streaming: false,
		onOpenFile: () => {},
	};
}

function markup(
	Card: (props: ToolRenderProps) => React.ReactNode,
	toolName: string,
	path: string,
	status?: ToolRenderProps["status"],
): string {
	return renderToStaticMarkup(createElement(Card, props(toolName, path, status)));
}

describe("structured tool file links", () => {
	it("opens relative and in-worktree absolute read paths under one canonical relative label", () => {
		const relative = markup(ReadCard, "read", "module-a/../README.md");
		const absolute = markup(ReadCard, "read", "/repo/module-a/SPEC.md");

		expect(relative).toContain('data-testid="tool-file-link"');
		expect(relative).toContain('data-path="README.md"');
		expect(relative).toContain(">README.md</button>");
		expect(absolute).toContain('data-path="module-a/SPEC.md"');
	});

	it("leaves foreign, escaping, and empty read paths as inert selectable text", () => {
		for (const path of ["/tmp/outside.png", "../outside.md", ""]) {
			const html = markup(ReadCard, "read", path);
			expect(html).not.toContain('data-testid="tool-file-link"');
			expect(html).toContain('data-testid="tool-file-reference"');
		}
	});

	it("presents a URL read as an external link, never a worktree file link", () => {
		const html = markup(ReadCard, "read", "https://example.com/a.md");
		expect(html).not.toContain('data-testid="tool-file-link"');
		expect(html).toContain('href="https://example.com/a.md"');
	});

	it("links the file behind an inline read selector and labels the range", () => {
		const ranged = markup(ReadCard, "read", "/repo/src/app.ts:50-80");
		expect(ranged).toContain('data-path="src/app.ts"');
		expect(ranged).toContain(">src/app.ts</button>");
		expect(ranged).toContain("lines 50–80");
		expect(markup(ReadCard, "read", "src/app.ts:3000+2")).toContain("lines 3000–3001");
		expect(markup(ReadCard, "read", "src/app.ts:1-20")).toContain("first 20 lines");
		expect(markup(ReadCard, "read", "src/app.ts:-15")).toContain("last 15 lines");
		expect(markup(ReadCard, "read", "src/app.ts:120")).toContain("from line 120");
		expect(markup(ReadCard, "read", "src/app.ts:5-16,960-973")).toContain(":5-16,960-973");
	});

	it("links a settled read to the path the tool resolved", () => {
		const html = renderToStaticMarkup(
			createElement(ReadCard, {
				...props("read", "src/ap.ts"),
				result: {
					content: [{ type: "text", text: "1|const a = 1;" }],
					details: {
						resolvedPath: "/repo/src/app.ts",
						displayContent: { text: "const a = 1;", startLine: 1 },
					},
				},
			}),
		);
		expect(html).toContain('data-path="src/app.ts"');
		expect(html).not.toContain("1|const");
	});

	it("links write and edit receipts only after their mutation settles", () => {
		for (const [Card, toolName] of [
			[WriteCard, "write"],
			[EditCard, "edit"],
		] as const) {
			expect(markup(Card, toolName, "README.md", "running")).not.toContain(
				'data-testid="tool-file-link"',
			);
			expect(markup(Card, toolName, "README.md", "error")).not.toContain(
				'data-testid="tool-file-link"',
			);
			expect(markup(Card, toolName, "README.md", "done")).toContain('data-testid="tool-file-link"');
		}
	});

	it("links every file an edit reports, even when its arguments carry no path", () => {
		const html = renderToStaticMarkup(
			createElement(EditCard, {
				...props("edit", ""),
				args: { input: "*** Begin Patch\n[src/a.ts#1a2b]\nPUT 2.=2:\n+b\n*** End Patch" },
				result: {
					content: [{ type: "text", text: "Updated src/a.ts" }],
					details: {
						diff: " 1|a\n-2|old\n+2|new\n   ...",
						path: "/repo/src/a.ts",
						op: "update",
					},
				},
			}),
		);
		expect(html).toContain('data-path="src/a.ts"');
		expect(html).toContain(">old</pre>");
		expect(html).toContain(">new</pre>");
		expect(html).toContain("…");
	});

	it("names a hashline edit's target from its input while it runs, and keeps a deleted file inert", () => {
		const running = renderToStaticMarkup(
			createElement(EditCard, {
				...props("edit", "", "running"),
				args: { input: "*** Begin Patch\n[src/a.ts#1a2b]\nREM\n*** End Patch" },
			}),
		);
		expect(running).toContain(">src/a.ts</span>");
		const deleted = renderToStaticMarkup(
			createElement(EditCard, {
				...props("edit", ""),
				args: {},
				result: {
					content: [{ type: "text", text: "Deleted" }],
					details: {
						diff: "",
						perFileResults: [
							{ path: "/repo/src/a.ts", diff: "", op: "delete" },
							{ path: "/repo/src/b.ts", diff: "+1|b", op: "create" },
						],
					},
				},
			}),
		);
		expect(deleted).not.toContain('data-path="src/a.ts"');
		expect(deleted).toContain('data-path="src/b.ts"');
		expect(deleted).toContain("deleted");
		expect(deleted).toContain("created");
	});
});
