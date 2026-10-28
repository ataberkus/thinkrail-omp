import { strArg } from "@thinkrail/extension-api/web";
import { projectRelativePath } from "@/lib";
import { registerToolRenderer } from "../toolRegistry";
import { BashCard } from "./BashCard";
import { EditCard } from "./EditCard";
import { editFiles } from "./editView";
import { ReadCard } from "./ReadCard";
import { RequestReviewCard, requestReviewSummary } from "./RequestReviewCard";
import { ResolveCommentCard } from "./ResolveCommentCard";
import { isWebReadPath } from "./readTarget";
import { SEARCH_TOOL_NAMES, SearchToolCard, searchToolSummary } from "./SearchToolCard";
import { SpecToolCard, specToolSummary } from "./SpecToolCard";
import "./mcp/register";
import "./subagent/register";
import "./web/register";
import { WriteCard } from "./WriteCard";

registerToolRenderer("bash", BashCard, { summary: ({ args }) => strArg(args, "command") });
registerToolRenderer("read", ReadCard, {
	summary: ({ args, workspaceRoot }) => {
		const path = strArg(args, "path").trim();
		return isWebReadPath(path) ? path : projectRelativePath(path, workspaceRoot);
	},
});
registerToolRenderer("edit", EditCard, {
	summary: ({ args, result, workspaceRoot }) =>
		editFiles(args, result)
			.map((file) => projectRelativePath(file.path, workspaceRoot))
			.join(", "),
});
registerToolRenderer("write", WriteCard, {
	summary: ({ args, workspaceRoot }) => projectRelativePath(strArg(args, "path"), workspaceRoot),
});

for (const toolName of SEARCH_TOOL_NAMES) {
	registerToolRenderer(toolName, SearchToolCard, { summary: searchToolSummary });
}

for (const toolName of [
	"spec_grep",
	"spec_get",
	"spec_graph",
	"spec_create",
	"spec_update",
	"spec_delete",
	"spec_validate",
]) {
	registerToolRenderer(toolName, SpecToolCard, { summary: specToolSummary });
}

registerToolRenderer("resolve_comment", ResolveCommentCard, {
	summary: ({ args }) => strArg(args, "commentId"),
});

registerToolRenderer("request_review", RequestReviewCard, {
	summary: requestReviewSummary,
	prominence: "primary",
	defaultExpanded: true,
});
