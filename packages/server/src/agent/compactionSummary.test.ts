import { expect, test } from "bun:test";
import {
	type CompactionSettings,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	MAX_SUMMARY_TOKENS,
} from "@oh-my-pi/pi-agent-core/compaction";
import { createFauxCore, fauxAssistantMessage } from "pi-faux";

test("turn-prefix summaries get half the compaction reserve as answer room, capped at the summary maximum", async () => {
	const faux = createFauxCore({
		models: [
			{ id: "summary-cap-probe", reasoning: false, contextWindow: 200_000, maxTokens: 64_000 },
		],
		tokensPerSecond: 100_000,
	});
	const model = faux.getModel();
	const budgets: { reserveTokens: number; maxTokens: number | undefined; prompt: string }[] = [];
	for (const reserveTokens of [16_384, 80_000]) {
		faux.setResponses(
			Array.from({ length: 4 }, () => (context, options) => {
				const first = context.messages[0];
				const prompt =
					first?.role === "user" && Array.isArray(first.content)
						? first.content.map((block) => (block.type === "text" ? block.text : "")).join("")
						: "";
				budgets.push({ reserveTokens, maxTokens: options?.maxTokens, prompt });
				return fauxAssistantMessage("Complete turn prefix");
			}),
		);
		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			enabled: true,
			reserveTokens,
			keepRecentTokens: 20_000,
		};
		const result = await compact(
			{
				firstKeptEntryId: "kept",
				messagesToSummarize: [],
				turnPrefixMessages: [{ role: "user", content: "Current work", timestamp: 1 }],
				recentMessages: [],
				isSplitTurn: true,
				tokensBefore: 10_000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings,
			},
			model,
			"fixture",
			undefined,
			undefined,
			{
				completeImpl: (requestModel, context, options) =>
					faux.stream(requestModel, context, options).result(),
				oneshotRetry: false,
			},
		);
		expect(result.summary).toContain("Complete turn prefix");
	}
	const turnPrefix = budgets.filter((budget) => budget.prompt.includes("Current work"));
	expect(turnPrefix.map(({ reserveTokens, maxTokens }) => [reserveTokens, maxTokens])).toEqual([
		[16_384, Math.floor(16_384 / 2)],
		[80_000, MAX_SUMMARY_TOKENS],
	]);
});
