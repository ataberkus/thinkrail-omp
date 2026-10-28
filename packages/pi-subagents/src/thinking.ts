import type { DelegationThinkingLevel } from "pi-delegation";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly DelegationThinkingLevel[];

const levels = new Set<string>(THINKING_LEVELS);

export function isThinkingLevel(value: string): value is DelegationThinkingLevel {
	return levels.has(value);
}
