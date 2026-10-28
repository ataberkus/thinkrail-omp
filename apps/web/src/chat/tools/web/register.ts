import { registerToolRenderer } from "../../toolRegistry";
import { WebSearchCard, webSearchSummary } from "./WebSearchCard";

registerToolRenderer("web_search", WebSearchCard, { summary: webSearchSummary });
