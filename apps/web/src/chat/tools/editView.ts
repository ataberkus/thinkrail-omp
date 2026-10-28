import { strArg } from "@thinkrail/extension-api/web";
import { detailsOf, recordsField, stringField } from "./toolDetails";

export interface EditFileView {
	path: string;
	sourcePath: string;
	op: string;
	diff: string;
}

export interface DiffLine {
	kind: "add" | "remove" | "context" | "elided";
	line: string;
	text: string;
}

const HASHLINE_HEADER = /^\[(.+)#[0-9A-Za-z]+\]\s*$/;
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/;
const NUMBERED_LINE = /^([+\- ])(\s*\d+)\|(.*)$/;
const LEGACY_LINE = /^([+\- ])(\s*\d+) (.*)$/;

function inputPaths(input: string): string[] {
	return input.split("\n").flatMap((line) => {
		const path = HASHLINE_HEADER.exec(line)?.[1] ?? PATCH_HEADER.exec(line)?.[1];
		return path ? [path.trim()] : [];
	});
}

export function editArgPaths(args: Record<string, unknown>): string[] {
	const path = strArg(args, "path");
	return [...new Set(path ? [path] : inputPaths(strArg(args, "input")))];
}

export function editFiles(args: Record<string, unknown>, result: unknown): EditFileView[] {
	const details = detailsOf(result);
	const perFile = recordsField(details, "perFileResults");
	const entries = perFile.length > 0 ? perFile : details ? [details] : [];
	const files = entries.flatMap((entry) => {
		const path = stringField(entry, "path");
		return path
			? [
					{
						path,
						sourcePath: stringField(entry, "sourcePath"),
						op: stringField(entry, "op"),
						diff: stringField(entry, "diff"),
					},
				]
			: [];
	});
	if (files.length > 0) return files;
	const argPaths = editArgPaths(args);
	const diff = stringField(details, "diff");
	return argPaths.map((path) => ({
		path,
		sourcePath: "",
		op: "",
		diff: argPaths.length === 1 ? diff : "",
	}));
}

function signKind(sign: string | undefined): DiffLine["kind"] {
	return sign === "+" ? "add" : sign === "-" ? "remove" : "context";
}

export function parseNumberedDiff(diff: string): DiffLine[] {
	if (!diff) return [];
	return diff.split("\n").flatMap((raw): DiffLine[] => {
		const match = NUMBERED_LINE.exec(raw) ?? LEGACY_LINE.exec(raw);
		if (match) {
			return [{ kind: signKind(match[1]), line: (match[2] ?? "").trim(), text: match[3] ?? "" }];
		}
		if (raw.trim().startsWith("...")) return [{ kind: "elided", line: "", text: "" }];
		return raw ? [{ kind: "context", line: "", text: raw }] : [];
	});
}

export function replacementDiff(args: Record<string, unknown>): DiffLine[] {
	const oldText = strArg(args, "old_string") || strArg(args, "oldText");
	const newText = strArg(args, "new_string") || strArg(args, "newText");
	const lines = (text: string, kind: DiffLine["kind"]): DiffLine[] =>
		text ? text.split("\n").map((line) => ({ kind, line: "", text: line })) : [];
	return [...lines(oldText, "remove"), ...lines(newText, "add")];
}
