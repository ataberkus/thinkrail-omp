import type { Translator } from "@thinkrail/locales/react";

const RANGE_CHUNK = String.raw`L?\d+(?:(?:\.\.|[-+])L?\d*)?`;
const LIST_CHUNK = String.raw`(?:${RANGE_CHUNK}|-\d+)`;
const LIST = `${LIST_CHUNK}(?:,${LIST_CHUNK})*`;
const FILE_SELECTOR = new RegExp(`^(?:${LIST}|raw|conflicts|img)$`, "i");
const LIST_ONLY = new RegExp(`^${LIST}$`, "i");
const URL_SELECTOR = new RegExp(`^(?:${LIST}|raw)$`, "i");
const SINGLE_RANGE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

export interface ReadTarget {
	path: string;
	selector: string;
}

export type ReadRange =
	| { kind: "from"; start: number }
	| { kind: "lines"; start: number; end: number }
	| { kind: "first"; count: number }
	| { kind: "last"; count: number };

export function isWebReadPath(path: string): boolean {
	return /^https?:\/\/?/i.test(path) || /^www\./i.test(path);
}

function parsesAsUrl(value: string): boolean {
	try {
		new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
		return true;
	} catch {
		return false;
	}
}

function splitWebTarget(raw: string): ReadTarget {
	let path = raw;
	const selectors: string[] = [];
	for (;;) {
		const colon = path.lastIndexOf(":");
		if (colon <= 0) break;
		const candidate = path.slice(colon + 1);
		const remainder = path.slice(0, colon);
		if (!URL_SELECTOR.test(candidate) || !isWebReadPath(remainder) || !parsesAsUrl(remainder))
			break;
		selectors.unshift(candidate);
		path = remainder;
	}
	return { path, selector: selectors.join(":") };
}

function splitFileTarget(raw: string): ReadTarget {
	const colon = raw.lastIndexOf(":");
	if (colon <= 0) return { path: raw, selector: "" };
	const candidate = raw.slice(colon + 1);
	if (!FILE_SELECTOR.test(candidate)) return { path: raw, selector: "" };
	const base = raw.slice(0, colon);
	const inner = base.lastIndexOf(":");
	const innerCandidate = base.slice(inner + 1);
	const compound =
		inner > 0 &&
		((LIST_ONLY.test(candidate) && innerCandidate.toLowerCase() === "raw") ||
			(candidate.toLowerCase() === "raw" && LIST_ONLY.test(innerCandidate)));
	return compound
		? { path: base.slice(0, inner), selector: `${innerCandidate}:${candidate}` }
		: { path: base, selector: candidate };
}

export function splitReadTarget(raw: string): ReadTarget {
	const trimmed = raw.trim();
	return isWebReadPath(trimmed) ? splitWebTarget(trimmed) : splitFileTarget(trimmed);
}

export function readRange(selector: string): ReadRange | null {
	if (!selector || selector.includes(",") || selector.includes(":")) return null;
	const tail = /^-(\d+)$/.exec(selector);
	if (tail) return { kind: "last", count: Number(tail[1]) };
	const match = SINGLE_RANGE.exec(selector);
	if (!match) return null;
	const start = Number(match[1]);
	const separator = match[2];
	const rhs = match[3] === undefined ? null : Number(match[3]);
	if (start < 1) return null;
	if (rhs === null) return { kind: "from", start };
	const end = separator === "+" ? start + rhs - 1 : rhs;
	if (end < start) return null;
	return start === 1 ? { kind: "first", count: end } : { kind: "lines", start, end };
}

export function readRangeLabel(t: Translator, selector: string): string {
	const range = readRange(selector);
	if (!range) return `:${selector}`;
	switch (range.kind) {
		case "from":
			return t("tools.read.fromLine", { offset: range.start });
		case "lines":
			return t("tools.read.lineRange", { start: range.start, end: range.end });
		case "first":
			return t("tools.read.firstLines", { count: range.count });
		case "last":
			return t("tools.read.lastLines", { count: range.count });
	}
}
