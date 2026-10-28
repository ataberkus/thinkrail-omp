import { RiPencilLine as Pencil } from "@remixicon/react";
import { resultText, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { projectRelativePath } from "@/lib";
import { Collapsible } from "./Collapsible";
import {
	type DiffLine,
	type EditFileView,
	editFiles,
	parseNumberedDiff,
	replacementDiff,
} from "./editView";
import { ToolFileLink } from "./ToolFileLink";

const DIFF_FADE = "bg-[linear-gradient(to_top,var(--container-elevated-bg),transparent)]";

export function EditCard({
	toolCallId,
	args,
	result,
	status,
	workspaceRoot,
	onOpenFile,
}: ToolRenderProps) {
	const files = editFiles(args, result);
	const headers = files.length > 0 ? files : [{ path: "", sourcePath: "", op: "", diff: "" }];

	if (status === "error") {
		return (
			<div data-testid="tool-edit" className="flex flex-col gap-4">
				{headers.map((file, index) => (
					<EditHeader
						key={`${index}:${file.path}`}
						file={file}
						workspaceRoot={workspaceRoot}
						onOpenFile={onOpenFile}
						disabled={true}
					/>
				))}
				<pre className="overflow-auto px-8 py-4 text-feedback-error tr-code-text">
					{resultText(result)}
				</pre>
			</div>
		);
	}

	const pending = replacementDiff(args);
	return (
		<div data-testid="tool-edit" className="flex flex-col gap-4">
			{headers.map((file, index) => {
				const lines = file.diff ? parseNumberedDiff(file.diff) : index === 0 ? pending : [];
				return (
					<div key={`${index}:${file.path}`} className="flex flex-col gap-4">
						<EditHeader
							file={file}
							workspaceRoot={workspaceRoot}
							onOpenFile={onOpenFile}
							disabled={status !== "done" || file.op === "delete"}
						/>
						{lines.length > 0 ? (
							<Collapsible
								id={index === 0 ? `${toolCallId}:content` : `${toolCallId}:content:${index}`}
								lines={lines.length}
								fadeClass={DIFF_FADE}
							>
								<DiffView lines={lines} />
							</Collapsible>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

const ROW_TONE: Record<
	DiffLine["kind"],
	{ row: string; sign: string; text: string; mark: string }
> = {
	add: {
		row: "bg-feedback-success-subtle",
		sign: "text-feedback-success-muted",
		text: "text-feedback-success",
		mark: "+",
	},
	remove: {
		row: "bg-feedback-error-subtle",
		sign: "text-feedback-error-muted",
		text: "text-feedback-error",
		mark: "−",
	},
	context: { row: "", sign: "text-text-muted", text: "text-text-default", mark: "" },
	elided: { row: "", sign: "text-text-muted", text: "text-text-muted", mark: "" },
};

function DiffView({ lines }: { lines: DiffLine[] }) {
	const numbered = lines.some((line) => line.line);
	return (
		<div className="overflow-auto rounded-sm border border-border-default tr-code-text leading-relaxed">
			{lines.map((line, i) => {
				const tone = ROW_TONE[line.kind];
				const key = `${i}:${line.kind}`;
				return (
					<div key={key} className={cn("flex", tone.row)}>
						<span className={cn("w-24 shrink-0 select-none px-4 text-right", tone.sign)}>
							{tone.mark}
						</span>
						{numbered ? (
							<span className="w-40 shrink-0 select-none px-4 text-right text-text-muted">
								{line.line}
							</span>
						) : null}
						<pre className={cn("min-w-0 flex-1 px-4 tr-code-text", tone.text)}>
							{line.kind === "elided" ? "…" : line.text}
						</pre>
					</div>
				);
			})}
		</div>
	);
}

function EditHeader({
	file,
	workspaceRoot,
	onOpenFile,
	disabled,
}: {
	file: EditFileView;
	workspaceRoot?: string | undefined;
	onOpenFile?: ((path: string) => void) | undefined;
	disabled: boolean;
}) {
	const t = useT();
	const verdict =
		file.op === "create"
			? t("tools.edit.created")
			: file.op === "delete"
				? t("tools.edit.deleted")
				: file.sourcePath
					? t("tools.edit.movedFrom", { path: projectRelativePath(file.sourcePath, workspaceRoot) })
					: t("tools.edit.edited");
	return (
		<div className="flex items-center gap-4 tr-text-metadata">
			<Pencil className="size-12 shrink-0 text-feedback-warning" />
			<ToolFileLink
				path={file.path}
				workspaceRoot={workspaceRoot}
				onOpenFile={onOpenFile}
				disabled={disabled}
				className="text-text-default"
			/>
			<span className="min-w-0 shrink-0 truncate text-text-muted">{verdict}</span>
		</div>
	);
}
