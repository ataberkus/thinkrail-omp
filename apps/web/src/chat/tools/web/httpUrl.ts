export function httpUrl(value: string): URL | null {
	const candidate = /^www\./i.test(value) ? `https://${value}` : value;
	try {
		const url = new URL(candidate);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}
