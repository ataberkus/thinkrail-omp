import { afterEach, expect, test } from "bun:test";
import { reachSharedHost, startSharedHostProxy } from "./sharedHost";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

test("returns the origin, dropping path and hash, once /health answers ok", async () => {
	const seen: string[] = [];
	const base = serve((request) => {
		seen.push(new URL(request.url).pathname);
		return new Response("ok");
	});
	expect(await reachSharedHost(`${base}/some/path#/v1`)).toBe(base);
	expect(seen).toEqual(["/health"]);
});

test("rejects non-http URLs and garbage before any request", async () => {
	await expect(reachSharedHost("file:///etc/passwd")).rejects.toThrow(
		"must be an http or https URL",
	);
	await expect(reachSharedHost("not a url")).rejects.toThrow("is not a valid URL");
});

test("a non-ok /health or an unreachable host names the origin", async () => {
	const base = serve(() => new Response("nope", { status: 503 }));
	await expect(reachSharedHost(base)).rejects.toThrow(
		`Could not reach the ThinkRail host at ${base}: /health answered 503`,
	);
	const closed = serve(() => new Response("ok"));
	servers.pop()?.stop(true);
	await expect(reachSharedHost(closed)).rejects.toThrow(
		`Could not reach the ThinkRail host at ${closed}`,
	);
});

test("a host that never answers times out", async () => {
	const base = serve(() => new Promise<Response>(() => {}));
	await expect(reachSharedHost(base, fetch, 100)).rejects.toThrow(
		`Could not reach the ThinkRail host at ${base}`,
	);
});

test("the loopback proxy forwards HTTP and WebSocket traffic to the shared host", async () => {
	const upstream = Bun.serve<{ path: string }, never>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/ws") {
				return srv.upgrade(request, { data: { path: `${url.pathname}${url.search}` } })
					? undefined
					: new Response("no", { status: 400 });
			}
			return new Response(
				`${request.method} ${url.pathname}${url.search} ${request.headers.get("host")}`,
			);
		},
		websocket: {
			message(ws, message) {
				ws.send(`${ws.data.path} echo ${message}`);
			},
		},
	});
	servers.push(upstream);
	const proxy = startSharedHostProxy(`http://127.0.0.1:${upstream.port}`);
	try {
		expect(proxy.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await (await fetch(`${proxy.origin}/files/a?x=1`)).text()).toBe(
			`GET /files/a?x=1 127.0.0.1:${upstream.port}`,
		);
		const socket = new WebSocket(`${proxy.origin.replace("http", "ws")}/ws?client=c1`);
		socket.onopen = () => socket.send("hi");
		const reply = await new Promise<string>((resolve) => {
			socket.onmessage = (event) => resolve(String(event.data));
		});
		expect(reply).toBe("/ws?client=c1 echo hi");
		socket.close();
	} finally {
		proxy.stop();
	}
});
