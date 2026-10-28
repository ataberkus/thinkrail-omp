const SEPARATOR = ":";

export function usagePurpose(kind: string, note?: string): string {
	return note ? `${kind}${SEPARATOR}${note}` : kind;
}

export function usagePurposeParts(purpose: string): { kind: string; note?: string } {
	const at = purpose.indexOf(SEPARATOR);
	if (at < 0) return { kind: purpose };
	const note = purpose.slice(at + 1);
	return note ? { kind: purpose.slice(0, at), note } : { kind: purpose.slice(0, at) };
}
