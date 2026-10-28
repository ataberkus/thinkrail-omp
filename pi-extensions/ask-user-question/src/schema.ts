import { z } from "@oh-my-pi/pi-coding-agent";
import {
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_RECOMMENDED_REASON_LENGTH,
	MIN_OPTIONS,
} from "./core.ts";

const OptionSchema = z.object({
	label: z
		.string()
		.describe(
			`MAX ${MAX_LABEL_LENGTH} CHARACTERS. The concise (1-5 word) text the user sees and selects.`,
		),
	description: z
		.string()
		.describe("What this option means or what happens if chosen — the trade-off/implication."),
	preview: z
		.string()
		.describe(
			"Optional markdown preview shown beside this option (mockups, code snippets, diagrams, configs). Single-select only.",
		)
		.optional(),
	recommendedReason: z
		.string()
		.describe(
			`MAX ${MAX_RECOMMENDED_REASON_LENGTH} CHARACTERS. Why you recommend this option — one short sentence, rendered as a 'Why:' line under the option. Set only on the option whose label carries '(Recommended)'.`,
		)
		.optional(),
});

const QuestionSchema = z.object({
	question: z
		.string()
		.describe(
			'The complete question, ending with a question mark. E.g. "Which library should we use for date formatting?"',
		),
	header: z
		.string()
		.describe(
			`MAX ${MAX_HEADER_LENGTH} CHARACTERS. Very short chip/tag next to the question, e.g. "Auth method".`,
		),
	options: z
		.array(OptionSchema)
		.min(MIN_OPTIONS)
		.max(MAX_OPTIONS)
		.describe(
			"2-4 distinct choices. An 'Other' free-text option and a Skip escape are added automatically — do NOT author 'Other'-style options.",
		),
	multiSelect: z
		.boolean()
		.describe(
			'Allow multiple selections. The "Other" free-text option stays available; its text arrives as an additional answer alongside the checked options.',
		)
		.optional(),
});

export const AskUserQuestionSchema = z.object({
	questions: z.array(QuestionSchema).min(1).describe("One or more questions to ask."),
});

export type AskUserQuestionParams = z.infer<typeof AskUserQuestionSchema>;
