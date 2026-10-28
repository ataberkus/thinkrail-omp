import { expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { toProviderUsage } from "./modelRuntime";

test("plan usage groups accounts per provider, resolves used fractions and drops empty reports", () => {
	const reports = [
		{
			provider: "anthropic",
			fetchedAt: 1,
			metadata: { email: "a@example.com", planType: "max" },
			limits: [
				{
					id: "5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic" },
					window: { id: "5h", label: "5 Hour", resetsAt: 5_000 },
					amount: { used: 42, unit: "percent" },
				},
				{
					id: "7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic" },
					amount: { remainingFraction: 0.25, unit: "percent" },
				},
			],
		},
		{
			provider: "anthropic",
			fetchedAt: 1,
			limits: [
				{ id: "x", label: "Extra", scope: { provider: "anthropic" }, amount: { unit: "usd" } },
			],
		},
		{ provider: "openai-codex", fetchedAt: 1, limits: [] },
	] as UsageReport[];

	expect(toProviderUsage(reports, (id) => (id === "anthropic" ? "Anthropic" : id))).toEqual([
		{
			providerId: "anthropic",
			name: "Anthropic",
			accounts: [
				{
					account: "a@example.com · max",
					limits: [
						{ label: "Claude 5 Hour", usedFraction: 0.42, resetsAt: 5_000 },
						{ label: "Claude 7 Day", usedFraction: 0.75 },
					],
				},
				{ limits: [{ label: "Extra", usedFraction: null }] },
			],
		},
	]);
});
