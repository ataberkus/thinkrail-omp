import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { DelegationThinkingLevel } from "./types";

const ENGINE_LEVELS = {
	off: ThinkingLevel.Off,
	minimal: ThinkingLevel.Minimal,
	low: ThinkingLevel.Low,
	medium: ThinkingLevel.Medium,
	high: ThinkingLevel.High,
	xhigh: ThinkingLevel.XHigh,
	max: ThinkingLevel.Max,
} as const satisfies Record<DelegationThinkingLevel, ThinkingLevel>;

export const THINKING_LEVELS: readonly DelegationThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function toEngineThinking(level: DelegationThinkingLevel): ThinkingLevel {
	return ENGINE_LEVELS[level];
}

export function fromEngineThinking(level: string | undefined): DelegationThinkingLevel | undefined {
	return THINKING_LEVELS.find((name) => ENGINE_LEVELS[name] === level);
}
