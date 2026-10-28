import { RiLinksLine as LinkIcon } from "@remixicon/react";
import { resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { Collapsible, countLines } from "../Collapsible";
import { readRangeLabel, splitReadTarget } from "../readTarget";
import { detailsOf, recordField, stringField } from "../toolDetails";
import { httpUrl } from "./httpUrl";
import { WebResultBody } from "./WebResultBody";

const URL_READ_HEADER_END = "\n---\n\n";

export function webReadContent(result: unknown): string {
	const details = detailsOf(result);
	const display = stringField(recordField(details, "displayContent"), "text");
	if (display) return display;
	const output = resultText(result);
	if (details?.kind !== "url" || details.raw === true || !output.startsWith("URL: ")) return output;
	const end = output.indexOf(URL_READ_HEADER_END);
	return end < 0 ? output : output.slice(end + URL_READ_HEADER_END.length);
}

export function WebFetchCard({ toolCallId, args, result, status }: ToolRenderProps) {
	const t = useT();
	const target = splitReadTarget(strArg(args, "path"));
	const details = detailsOf(result);
	const href = httpUrl(stringField(details, "finalUrl") || target.path);
	const label = href ? href.hostname.replace(/^www\./, "") : target.path;
	const output = webReadContent(result);
	const markdown = !target.selector && details?.raw !== true;

	return (
		<div data-testid="tool-read-url" className="flex flex-col gap-4">
			<div className="flex items-center gap-4 tr-text-metadata">
				<LinkIcon className="size-12 shrink-0 text-text-muted" />
				{href ? (
					<a
						href={href.href}
						target="_blank"
						rel="noreferrer"
						className="min-w-0 truncate text-primary hover:underline"
						title={href.href}
					>
						{label}
					</a>
				) : (
					<span className="min-w-0 truncate text-primary" title={target.path}>
						{label}
					</span>
				)}
				{target.selector ? (
					<span className="shrink-0 text-text-muted">{readRangeLabel(t, target.selector)}</span>
				) : null}
			</div>
			{markdown || status !== "done" || !output ? (
				<WebResultBody
					id={`${toolCallId}:content`}
					output={output}
					status={status}
					runningLabel={t("tools.webFetch.running")}
					emptyLabel={t("tools.webFetch.empty")}
				/>
			) : (
				<Collapsible id={`${toolCallId}:content`} lines={countLines(output)}>
					<pre className="overflow-auto rounded-sm bg-container-header-bg p-8 tr-code-text text-text-default">
						{output}
					</pre>
				</Collapsible>
			)}
		</div>
	);
}
