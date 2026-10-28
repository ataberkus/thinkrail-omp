import { resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { projectRelativePath } from "@/lib";
import { detailsOf, recordField, stringField } from "./toolDetails";

export function BashCard({ args, result, status, workspaceRoot }: ToolRenderProps) {
	const t = useT();
	const command = strArg(args, "command");
	const cwd = strArg(args, "cwd").trim();
	const output = resultText(result);
	const isError = status === "error";
	const job = recordField(detailsOf(result), "async");
	const jobId = stringField(job, "state") === "running" ? stringField(job, "jobId") : "";

	return (
		<div
			data-testid="tool-bash"
			className="overflow-hidden rounded-sm border border-border-default bg-container-header-bg tr-code-text"
		>
			<div className="border-border-default border-b px-8 py-4">
				<span className="text-feedback-success">$</span>
				<span className="ml-8 text-text-muted">{command}</span>
				{cwd ? (
					<span className="ml-8 text-text-muted tr-text-metadata">
						{t("tools.bash.cwd", { cwd: projectRelativePath(cwd, workspaceRoot) || cwd })}
					</span>
				) : null}
			</div>
			<pre
				className={`overflow-auto px-8 py-4 tr-code-text leading-relaxed ${isError ? "text-feedback-error" : "text-text-default"}`}
			>
				{output || (status === "running" ? t("tools.bash.running") : t("tools.bash.noOutput"))}
			</pre>
			{jobId ? (
				<div className="border-border-default border-t px-8 py-4 text-text-muted tr-text-metadata">
					{t("tools.bash.background", { jobId })}
				</div>
			) : null}
		</div>
	);
}
