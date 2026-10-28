import { RiFileTextLine as FileText } from "@remixicon/react";
import {
	languageFromPath,
	resultText,
	strArg,
	type ToolRenderProps,
} from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { CodeBlock } from "./CodeBlock";
import { Collapsible, countLines } from "./Collapsible";
import { isWebReadPath, readRangeLabel, splitReadTarget } from "./readTarget";
import { ToolFileLink } from "./ToolFileLink";
import { detailsOf, recordField, stringField } from "./toolDetails";
import { WebFetchCard } from "./web/WebFetchCard";

export function ReadCard(props: ToolRenderProps) {
	const { toolCallId, args, result, status, workspaceRoot, onOpenFile } = props;
	const t = useT();
	const target = splitReadTarget(strArg(args, "path"));
	const details = detailsOf(result);
	if (isWebReadPath(target.path) || details?.kind === "url") return <WebFetchCard {...props} />;

	const linkPath = (status === "done" && stringField(details, "resolvedPath")) || target.path;
	const output = stringField(recordField(details, "displayContent"), "text") || resultText(result);
	const lang = details?.isDirectory === true ? "" : languageFromPath(target.path);

	return (
		<div data-testid="tool-read" className="flex flex-col gap-4">
			<div className="flex items-center gap-4 tr-text-metadata">
				<FileText className="size-12 shrink-0 text-text-muted" />
				<ToolFileLink
					path={linkPath}
					workspaceRoot={workspaceRoot}
					onOpenFile={onOpenFile}
					disabled={status === "running"}
					className="text-primary"
				/>
				{target.selector ? (
					<span className="shrink-0 text-text-muted">{readRangeLabel(t, target.selector)}</span>
				) : null}
			</div>
			{status === "running" ? (
				<span className="text-text-muted tr-text-metadata">{t("tools.read.reading")}</span>
			) : status === "error" ? (
				<pre className="overflow-auto px-8 py-4 text-feedback-error tr-code-text">
					{resultText(result)}
				</pre>
			) : output ? (
				<Collapsible id={`${toolCallId}:content`} lines={countLines(output)}>
					<CodeBlock code={output} lang={lang} />
				</Collapsible>
			) : (
				<span className="text-text-muted tr-text-metadata italic">{t("tools.read.emptyFile")}</span>
			)}
		</div>
	);
}
