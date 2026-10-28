import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "@thinkrail/contracts";

const LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function levelOf(effort: string): ThinkingLevel | undefined {
	return LEVELS.find((level) => level === effort);
}

export function supportedThinkingLevels(
	model: Pick<Model<Api>, "reasoning" | "thinking">,
): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const declared = new Set(
		(model.thinking?.efforts ?? []).flatMap((effort) => {
			const level = levelOf(String(effort));
			return level ? [level] : [];
		}),
	);
	return LEVELS.filter((level) => level === "off" || declared.has(level));
}

export function clampThinkingLevel(
	model: Pick<Model<Api>, "reasoning" | "thinking">,
	level: ThinkingLevel,
): ThinkingLevel {
	const available = supportedThinkingLevels(model);
	if (available.includes(level)) return level;
	const requested = LEVELS.indexOf(level);
	for (let index = requested; index < LEVELS.length; index++) {
		const candidate = LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	for (let index = requested - 1; index >= 0; index--) {
		const candidate = LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

export function wireThinkingLevel(level: string | undefined): ThinkingLevel {
	return (level === undefined ? undefined : levelOf(level)) ?? "off";
}

export function engineThinkingLevel(
	model: Pick<Model<Api>, "reasoning" | "thinking">,
	level: ThinkingLevel,
): "off" | NonNullable<NonNullable<Model<Api>["thinking"]>["efforts"]>[number] {
	const clamped = clampThinkingLevel(model, level);
	if (clamped === "off") return "off";
	return model.thinking?.efforts?.find((effort) => String(effort) === clamped) ?? "off";
}
