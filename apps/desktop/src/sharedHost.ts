export const SHARED_HOST_TIMEOUT_MS = 5_000;

export interface SharedHostProxy {
	readonly origin: string;
	stop(): void;
}

interface ProxySocketData {
	target: string;
	upstream?: WebSocket;
	pending: (string | Uint8Array<ArrayBuffer>)[];
}

export async function reachSharedHost(
	rawUrl: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = SHARED_HOST_TIMEOUT_MS,
): Promise<string> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`THINKRAIL_DESKTOP_HOST_URL is not a valid URL: ${rawUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`THINKRAIL_DESKTOP_HOST_URL must be an http or https URL: ${rawUrl}`);
	}
	const unreachable = `Could not reach the ThinkRail host at ${url.origin}`;
	let response: Response;
	try {
		response = await fetchImpl(`${url.origin}/health`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new Error(`${unreachable}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`${unreachable}: /health answered ${response.status}`);
	return url.origin;
}

export function startSharedHostProxy(remoteOrigin: string): SharedHostProxy {
	const wsOrigin = remoteOrigin.replace(/^http/, "ws");
	const server = Bun.serve<ProxySocketData, never>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			const path = `${url.pathname}${url.search}`;
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				return srv.upgrade(request, { data: { target: `${wsOrigin}${path}`, pending: [] } })
					? undefined
					: new Response("ws upgrade failed", { status: 400 });
			}
			const headers = new Headers(request.headers);
			headers.delete("host");
			return fetch(`${remoteOrigin}${path}`, {
				method: request.method,
				headers,
				body: request.body,
				redirect: "manual",
				signal: request.signal,
			});
		},
		websocket: {
			open(ws) {
				const upstream = new WebSocket(ws.data.target);
				upstream.binaryType = "arraybuffer";
				ws.data.upstream = upstream;
				upstream.onopen = () => {
					for (const message of ws.data.pending.splice(0)) upstream.send(message);
				};
				upstream.onmessage = (event) => {
					ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
				};
				upstream.onclose = (event) =>
					ws.close(event.code === 1005 ? 1000 : event.code, event.reason);
				upstream.onerror = () => ws.close(1011, "shared host connection failed");
			},
			message(ws, message) {
				const data = typeof message === "string" ? message : new Uint8Array(message);
				const upstream = ws.data.upstream;
				if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
				else ws.data.pending.push(data);
			},
			close(ws) {
				ws.data.upstream?.close();
			},
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
