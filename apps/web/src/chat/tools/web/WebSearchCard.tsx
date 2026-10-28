import { RiSearchLine as Search } from "@remixicon/react";
import { resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { Markdown } from "../../Markdown";
import { Collapsible, countLines } from "../Collapsible";
import { detailsOf, recordField, recordsField, stringField } from "../toolDetails";
import { httpUrl } from "./httpUrl";
import { WebResultBody } from "./WebResultBody";

interface SearchLink {
	title: string;
	url: string;
	excerpt: string;
}

export interface WebSearchView {
	provider: string;
	error: string;
	answer: string;
	sources: SearchLink[];
	citations: SearchLink[];
}

function links(
	response: Record<string, unknown> | null,
	key: string,
	excerptKey: string,
): SearchLink[] {
	return recordsField(response, key).flatMap((item) => {
		const url = stringField(item, "url");
		return url
			? [{ title: stringField(item, "title") || url, url, excerpt: stringField(item, excerptKey) }]
			: [];
	});
}

export function webSearchView(result: unknown): WebSearchView {
	const details = detailsOf(result);
	const response = recordField(details, "response");
	const provider = stringField(response, "provider");
	return {
		provider: provider === "none" ? "" : provider,
		error: stringField(details, "error"),
		answer: stringField(response, "answer"),
		sources: links(response, "sources", "snippet"),
		citations: links(response, "citations", "citedText"),
	};
}

export function webSearchSummary({ args }: ToolRenderProps): string {
	return strArg(args, "query");
}

export function WebSearchCard({ toolCallId, args, result, status }: ToolRenderProps) {
	const t = useT();
	const query = strArg(args, "query");
	const view = webSearchView(result);
	const structured =
		status === "done" &&
		!view.error &&
		(view.answer || view.sources.length > 0 || view.citations.length > 0);

	return (
		<div data-testid="tool-web_search" className="flex flex-col gap-4">
			<div className="flex items-center gap-4 tr-text-metadata">
				<Search className="size-12 shrink-0 text-text-muted" />
				<span className="truncate text-primary" title={query}>
					{query}
				</span>
				{view.provider ? (
					<span className="shrink-0 text-text-muted">
						{t("tools.webSearch.via", { provider: view.provider })}
					</span>
				) : null}
			</div>
			{structured ? (
				<Collapsible
					id={`${toolCallId}:content`}
					lines={countLines(view.answer) + 2 * (view.sources.length + view.citations.length)}
				>
					<div className="flex flex-col gap-8">
						{view.answer ? <Markdown text={view.answer} /> : null}
						<LinkList heading={t("tools.webSearch.sources")} items={view.sources} />
						<LinkList heading={t("tools.webSearch.citations")} items={view.citations} />
					</div>
				</Collapsible>
			) : (
				<WebResultBody
					id={`${toolCallId}:content`}
					output={view.error || resultText(result)}
					status={view.error ? "error" : status}
					runningLabel={t("tools.webSearch.running")}
					emptyLabel={t("tools.webSearch.empty")}
				/>
			)}
		</div>
	);
}

function LinkList({ heading, items }: { heading: string; items: SearchLink[] }) {
	if (items.length === 0) return null;
	return (
		<section className="flex flex-col gap-4">
			<h4 className="text-text-muted tr-text-metadata">{heading}</h4>
			<ol className="flex flex-col gap-4">
				{items.map((item, index) => {
					const href = httpUrl(item.url);
					return (
						<li key={`${index}:${item.url}`} className="flex min-w-0 flex-col tr-text-metadata">
							<span className="flex min-w-0 items-baseline gap-4">
								{href ? (
									<a
										href={href.href}
										target="_blank"
										rel="noreferrer"
										className="min-w-0 truncate text-primary hover:underline"
										title={href.href}
									>
										{item.title}
									</a>
								) : (
									<span className="min-w-0 truncate text-text-default" title={item.url}>
										{item.title}
									</span>
								)}
								{href ? (
									<span className="shrink-0 text-text-muted">
										{href.hostname.replace(/^www\./, "")}
									</span>
								) : null}
							</span>
							{item.excerpt ? (
								<span className="line-clamp-2 text-text-muted">{item.excerpt}</span>
							) : null}
						</li>
					);
				})}
			</ol>
		</section>
	);
}
