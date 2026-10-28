import { memo } from "react";
import { Markdown } from "./Markdown";

interface MarkdownNode {
	type: string;
	value?: string;
	children?: MarkdownNode[];
}

function remarkSoftBreaks() {
	const visit = (node: MarkdownNode) => {
		if (!node.children) return;
		node.children = node.children.flatMap((child): MarkdownNode[] => {
			if (child.type !== "text" || !child.value?.includes("\n")) {
				visit(child);
				return [child];
			}
			return child.value
				.split("\n")
				.flatMap((value, i): MarkdownNode[] =>
					i === 0 ? [{ type: "text", value }] : [{ type: "break" }, { type: "text", value }],
				);
		});
	};
	return visit;
}

const USER_REMARK_PLUGINS = [remarkSoftBreaks];

export const UserMarkdown = memo(function UserMarkdown({ text }: { text: string }) {
	return <Markdown text={text} remarkPlugins={USER_REMARK_PLUGINS} />;
});
