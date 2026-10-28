import { Theme, type ThemeBg, type ThemeColor } from "@oh-my-pi/pi-coding-agent";

const FG_COLORS: Record<ThemeColor, string> = {
	accent: "",
	border: "",
	borderAccent: "",
	borderMuted: "",
	success: "",
	error: "",
	warning: "",
	muted: "",
	dim: "",
	text: "",
	assistantMessageText: "",
	thinkingText: "",
	userMessageText: "",
	customMessageText: "",
	customMessageLabel: "",
	toolTitle: "",
	toolOutput: "",
	mdHeading: "",
	mdLink: "",
	mdLinkUrl: "",
	mdCode: "",
	mdCodeBlock: "",
	mdCodeBlockBorder: "",
	mdQuote: "",
	mdQuoteBorder: "",
	mdHr: "",
	mdListBullet: "",
	toolDiffAdded: "",
	toolDiffRemoved: "",
	toolDiffContext: "",
	syntaxComment: "",
	syntaxKeyword: "",
	syntaxFunction: "",
	syntaxVariable: "",
	syntaxString: "",
	syntaxNumber: "",
	syntaxType: "",
	syntaxOperator: "",
	syntaxPunctuation: "",
	thinkingOff: "",
	thinkingMinimal: "",
	thinkingLow: "",
	thinkingMedium: "",
	thinkingHigh: "",
	thinkingXhigh: "",
	thinkingMax: "",
	bashMode: "",
	pythonMode: "",
	statusLineSep: "",
	statusLineModel: "",
	statusLinePath: "",
	statusLineGitClean: "",
	statusLineGitDirty: "",
	statusLineContext: "",
	statusLineSpend: "",
	statusLineStaged: "",
	statusLineDirty: "",
	statusLineUntracked: "",
	statusLineOutput: "",
	statusLineCost: "",
	statusLineSubagents: "",
};

const BG_COLORS: Record<ThemeBg, string> = {
	selectedBg: "",
	userMessageBg: "",
	customMessageBg: "",
	toolPendingBg: "",
	toolSuccessBg: "",
	toolErrorBg: "",
	statusLineBg: "",
};

class PlainTextTheme extends Theme {
	constructor() {
		super(FG_COLORS, BG_COLORS, "truecolor", "unicode", {});
	}

	override fg(_color: ThemeColor, text: string): string {
		return text;
	}

	override fgResolved(_color: ThemeColor, text: string): string {
		return text;
	}

	override bg(_color: ThemeBg, text: string): string {
		return text;
	}

	override bgFill(_color: ThemeBg, text: string): string {
		return text;
	}

	override fgOnBg(_color: ThemeColor, _background: ThemeBg, text: string): string {
		return text;
	}

	override bold(text: string): string {
		return text;
	}

	override italic(text: string): string {
		return text;
	}

	override underline(text: string): string {
		return text;
	}

	override inverse(text: string): string {
		return text;
	}

	override strikethrough(text: string): string {
		return text;
	}

	override getFgAnsi(_color: ThemeColor): string {
		return "";
	}

	override getBgAnsi(_color: ThemeBg): string {
		return "";
	}

	override getFgOnBgAnsi(_color: ThemeColor, _background: ThemeBg): string {
		return "";
	}

	override getContrastFgAnsi(_fillColor: ThemeColor): string {
		return "";
	}

	override getLangIconStyled(lang: string | undefined): string {
		return this.getLangIcon(lang);
	}
}

export const plainTextTheme: Theme = new PlainTextTheme();
