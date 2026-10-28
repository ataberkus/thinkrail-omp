import { isRecord } from "@/lib";

export function detailsOf(result: unknown): Record<string, unknown> | null {
	return isRecord(result) && isRecord(result.details) ? result.details : null;
}

export function recordField(
	value: Record<string, unknown> | null,
	key: string,
): Record<string, unknown> | null {
	const field = value?.[key];
	return isRecord(field) ? field : null;
}

export function stringField(value: Record<string, unknown> | null, key: string): string {
	const field = value?.[key];
	return typeof field === "string" ? field : "";
}

export function numberField(value: Record<string, unknown> | null, key: string): number | null {
	const field = value?.[key];
	return typeof field === "number" && Number.isFinite(field) ? field : null;
}

export function recordsField(
	value: Record<string, unknown> | null,
	key: string,
): Record<string, unknown>[] {
	const field = value?.[key];
	return Array.isArray(field) ? field.filter(isRecord) : [];
}

export function stringsField(value: Record<string, unknown> | null, key: string): string[] {
	const field = value?.[key];
	return Array.isArray(field)
		? field.filter((item): item is string => typeof item === "string")
		: [];
}
