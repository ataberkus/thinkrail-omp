import { describe, expect, test } from "bun:test";
import { parseTailscaleStatus } from "./tailscale";

function status(
	overrides: Record<string, unknown> = {},
	self: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		BackendState: "Running",
		Self: {
			DNSName: "laptop.tail1234.ts.net.",
			TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
			...self,
		},
		CurrentTailnet: { Name: "me@example.com", MagicDNSEnabled: true },
		...overrides,
	});
}

describe("parseTailscaleStatus", () => {
	test("a running node yields its IPv4 and MagicDNS name without the trailing dot", () => {
		expect(parseTailscaleStatus(status())).toEqual({
			ip: "100.101.102.103",
			dnsName: "laptop.tail1234.ts.net",
		});
	});

	test("the IPv4 is picked even when IPv6 is listed first", () => {
		const json = status({}, { TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.0.7"] });
		expect(parseTailscaleStatus(json).ip).toBe("100.64.0.7");
	});

	test("MagicDNS off leaves no name, so the caller falls back to the IP", () => {
		expect(
			parseTailscaleStatus(status({ CurrentTailnet: { MagicDNSEnabled: false } })).dnsName,
		).toBeNull();
		expect(parseTailscaleStatus(status({}, { DNSName: "" })).dnsName).toBeNull();
	});

	test("a logged-out node is refused with the state and the fix", () => {
		const json = status({ BackendState: "NeedsLogin", Self: { DNSName: "", TailscaleIPs: null } });
		expect(() => parseTailscaleStatus(json)).toThrow(
			/not connected \(state: NeedsLogin\).*tailscale up/,
		);
	});

	test("a node without an IPv4 address is refused", () => {
		expect(() => parseTailscaleStatus(status({}, { TailscaleIPs: ["fd7a:115c:a1e0::1"] }))).toThrow(
			/no IPv4 address/,
		);
	});

	test("unreadable output is refused rather than thrown as a SyntaxError", () => {
		expect(() => parseTailscaleStatus("failed to connect to local tailscaled")).toThrow(
			/unreadable status/,
		);
	});
});
