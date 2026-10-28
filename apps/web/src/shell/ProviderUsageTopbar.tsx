import { RiDashboard3Line as Gauge } from "@remixicon/react";
import {
	PROVIDER_USAGE_PROTOCOL_VERSION,
	type ProviderUsageLimit,
	type ProviderUsageProvider,
	type ProviderUsageSnapshot,
} from "@thinkrail/contracts";
import { localeOf, type Translator, useT } from "@thinkrail/locales/react";
import { Popover, PopoverContent, PopoverTrigger } from "@thinkrail/ui/popover";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { getTransport } from "@/transport";
import { type QuotaPolling, startQuotaPolling } from "./jbcentralQuota";

const REFRESH_MS = 2 * 60_000;
const BAR_CELLS = 10;
const HIGH_USAGE = 0.9;

type ProviderUsageView = Extract<ProviderUsageSnapshot, { state: "available" }> & {
	stale: boolean;
};

export function highestUsedFraction(providers: readonly ProviderUsageProvider[]): number | null {
	let highest: number | null = null;
	for (const provider of providers)
		for (const account of provider.accounts)
			for (const limit of account.limits)
				if (limit.usedFraction !== null && (highest === null || limit.usedFraction > highest))
					highest = limit.usedFraction;
	return highest;
}

export function usageBar(fraction: number): string {
	const filled = Math.round(Math.min(1, Math.max(0, fraction)) * BAR_CELLS);
	return `${"▰".repeat(filled)}${"▱".repeat(BAR_CELLS - filled)}`;
}

function percent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

export function resetLabel(t: Translator, resetsAt: number, now: number): string {
	const ms = resetsAt - now;
	if (ms <= 0) return t("shell.providerUsage.resetsNow");
	if (ms < 24 * 3_600_000) {
		const minutes = Math.ceil(ms / 60_000);
		return t("shell.providerUsage.resetsIn", {
			hours: Math.floor(minutes / 60),
			minutes: minutes % 60,
		});
	}
	const time = new Date(resetsAt).toLocaleString(localeOf(t), {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});
	return t("shell.providerUsage.resetsAt", { time });
}

function LimitRow({ limit, now }: { limit: ProviderUsageLimit; now: number }) {
	const t = useT();
	const high = limit.usedFraction !== null && limit.usedFraction >= HIGH_USAGE;
	return (
		<li data-testid="provider-usage-limit" className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-12">
				<span className="truncate text-text-default tr-text-ui">{limit.label}</span>
				<span
					className={`whitespace-nowrap tr-text-ui ${high ? "text-feedback-error" : "text-text-muted"}`}
				>
					{limit.usedFraction === null
						? t("shell.providerUsage.unknown")
						: t("shell.providerUsage.used", { value: percent(limit.usedFraction) })}
				</span>
			</div>
			{limit.usedFraction === null ? null : (
				<span
					aria-hidden="true"
					className={`tr-text-metadata ${high ? "text-feedback-error" : "text-primary"}`}
				>
					{usageBar(limit.usedFraction)}
				</span>
			)}
			{limit.detail || limit.resetsAt !== undefined ? (
				<span className="text-text-muted tr-text-metadata">
					{[
						limit.detail,
						limit.resetsAt === undefined ? undefined : resetLabel(t, limit.resetsAt, now),
					]
						.filter(Boolean)
						.join(" · ")}
				</span>
			) : null}
		</li>
	);
}

export function ProviderUsageIndicator({
	view,
	onRefresh,
}: {
	view: ProviderUsageView;
	onRefresh: () => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const highest = highestUsedFraction(view.providers);
	const updated = new Date(view.observedAt).toLocaleTimeString(localeOf(t), {
		hour: "numeric",
		minute: "2-digit",
	});
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				data-testid="provider-usage"
				data-stale={view.stale}
				aria-label={t("shell.providerUsage.label", {
					value: highest === null ? "?" : percent(highest),
				})}
				className="inline-flex shrink-0 items-center gap-4 whitespace-nowrap rounded-sm text-text-default tr-text-ui outline-none hover:text-text-default focus-visible:ring-2 focus-visible:ring-primary"
			>
				<Gauge className="size-14 text-text-muted" aria-hidden="true" />
				<span className={highest !== null && highest >= HIGH_USAGE ? "text-feedback-error" : ""}>
					{highest === null ? "?" : percent(highest)}
				</span>
				{view.stale ? (
					<span className="size-6 rounded-full bg-feedback-warning" aria-hidden="true" />
				) : null}
			</PopoverTrigger>
			<PopoverContent align="end" className="flex max-h-[80vh] w-[280px] flex-col gap-12 p-12">
				<div className="flex min-h-0 flex-col gap-12 overflow-y-auto">
					{view.providers.map((provider) => (
						<section key={provider.providerId} className="flex flex-col gap-8">
							<h3 className="text-text-default tr-text-emphasis">{provider.name}</h3>
							{provider.accounts.map((account, index) => (
								<div key={account.account ?? index} className="flex flex-col gap-8">
									{account.account ? (
										<span className="truncate text-text-muted tr-text-metadata">
											{account.account}
										</span>
									) : null}
									<ul className="flex flex-col gap-8">
										{account.limits.map((limit) => (
											<LimitRow
												key={`${limit.label}|${limit.detail}|${limit.resetsAt}|${limit.usedFraction}`}
												limit={limit}
												now={Date.now()}
											/>
										))}
									</ul>
								</div>
							))}
						</section>
					))}
				</div>
				<div className="flex items-center justify-between gap-8 border-border-muted border-t pt-8">
					<span className="text-text-muted tr-text-metadata">
						{view.stale
							? t("shell.providerUsage.stale", { time: updated })
							: t("shell.providerUsage.updated", { time: updated })}
					</span>
					<button
						type="button"
						data-testid="provider-usage-refresh"
						onClick={onRefresh}
						className="rounded-sm text-text-muted tr-text-metadata outline-none hover:text-text-default focus-visible:ring-2 focus-visible:ring-primary"
					>
						{t("shell.providerUsage.refresh")}
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function ProviderUsageTopbar() {
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const connectionStatus = useAppStore((state) => state.status);
	const providerVersion = useAppStore((state) => state.providerVersion);
	const [visible, setVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState === "visible",
	);
	const [view, setView] = useState<ProviderUsageView | null>(null);
	const pollingRef = useRef<QuotaPolling | null>(null);
	const supported = protocolVersion !== null && protocolVersion >= PROVIDER_USAGE_PROTOCOL_VERSION;

	useEffect(() => {
		const update = () => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);

	useEffect(() => {
		if (!supported || connectionStatus !== "connected" || !visible) return;
		const polling = startQuotaPolling<ProviderUsageSnapshot>({
			intervalMs: REFRESH_MS,
			request: (force) => getTransport().request("provider.usage", force ? { force: true } : {}),
			onSnapshot: (snapshot) =>
				setView(snapshot.state === "available" ? { ...snapshot, stale: false } : null),
			onError: () => setView((current) => (current ? { ...current, stale: true } : null)),
		});
		pollingRef.current = polling;
		return () => {
			polling.stop();
			if (pollingRef.current === polling) pollingRef.current = null;
		};
	}, [connectionStatus, providerVersion, supported, visible]);

	const refresh = useCallback(() => pollingRef.current?.retry(), []);
	return view ? <ProviderUsageIndicator view={view} onRefresh={refresh} /> : null;
}
