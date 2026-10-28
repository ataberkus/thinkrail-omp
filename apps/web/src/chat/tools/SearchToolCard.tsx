import { RiPencilLine as Pencil, RiSearchLine as Search } from "@remixicon/react";
import { resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { type Translator, useT } from "@thinkrail/locales/react";
import { projectRelativePath } from "@/lib";
import { Collapsible, countLines } from "./Collapsible";
import { detailsOf, numberField, recordsField, stringField, stringsField } from "./toolDetails";

export const SEARCH_TOOL_NAMES = ["grep", "glob", "find", "ast_grep", "ast_edit"] as const;

function searchPattern(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "glob":
			return strArg(args, "path");
		case "find":
			return strArg(args, "query");
		case "ast_grep":
			return strArg(args, "pat");
		case "ast_edit": {
			const [op] = recordsField(args, "ops");
			return op ? stringField(op, "pat") : "";
		}
		default:
			return strArg(args, "pattern");
	}
}

function searchScope(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "glob") return "";
	if (toolName === "ast_edit") return stringsField(args, "paths").join("; ");
	return strArg(args, "path");
}

function searchCount(t: Translator, toolName: string, result: unknown): string {
	const details = detailsOf(result);
	switch (toolName) {
		case "glob": {
			const count = numberField(details, "fileCount");
			return count === null ? "" : t("tools.search.files", { count });
		}
		case "find": {
			const hits = details?.hits;
			return Array.isArray(hits) ? t("tools.search.files", { count: hits.length }) : "";
		}
		case "ast_edit": {
			const count = numberField(details, "totalReplacements");
			return count === null ? "" : t("tools.search.replacements", { count });
		}
		default: {
			const count = numberField(details, "matchCount");
			return count === null ? "" : t("tools.search.matches", { count });
		}
	}
}

export function searchToolSummary({ toolName, args }: ToolRenderProps): string {
	return searchPattern(toolName, args);
}

export function SearchToolCard({
	toolCallId,
	toolName,
	args,
	result,
	status,
	workspaceRoot,
}: ToolRenderProps) {
	const t = useT();
	const details = detailsOf(result);
	const pattern = searchPattern(toolName, args);
	const scope = searchScope(toolName, args);
	const failure = status === "error" ? resultText(result) : stringField(details, "error");
	const output = stringField(details, "displayContent") || resultText(result);
	const count = status === "done" && !failure ? searchCount(t, toolName, result) : "";
	const Icon = toolName === "ast_edit" ? Pencil : Search;

	return (
		<div data-testid={`tool-${toolName}`} className="flex flex-col gap-4">
			<div className="flex min-w-0 items-center gap-4 tr-text-metadata">
				<Icon className="size-12 shrink-0 text-text-muted" />
				<span className="min-w-0 truncate text-primary tr-code-text" title={pattern}>
					{pattern}
				</span>
				{scope ? (
					<span className="min-w-0 truncate text-text-muted" title={scope}>
						{projectRelativePath(scope, workspaceRoot)}
					</span>
				) : null}
				{count ? <span className="shrink-0 text-text-muted">{count}</span> : null}
			</div>
			{status === "running" ? (
				<span className="text-text-muted tr-text-metadata">{t("tools.search.running")}</span>
			) : failure ? (
				<pre className="overflow-auto px-8 py-4 text-feedback-error tr-code-text">{failure}</pre>
			) : output ? (
				<Collapsible id={`${toolCallId}:content`} lines={countLines(output)}>
					<pre className="overflow-auto rounded-sm bg-container-header-bg p-8 tr-code-text text-text-default">
						{output}
					</pre>
				</Collapsible>
			) : (
				<span className="text-text-muted tr-text-metadata italic">{t("tools.search.empty")}</span>
			)}
		</div>
	);
}
