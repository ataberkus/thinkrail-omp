import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_ENV_MARKER } from "@thinkrail/shared/shellEnv";

export function resolveBunExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const name = process.platform === "win32" ? "bun.exe" : "bun";
	const executable = (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((directory) => join(directory, name))
		.find(existsSync);
	if (!executable) throw new Error("bun executable not found for the e2e host");
	return executable;
}

export function hermeticE2ePath(fakeBinDir: string): string {
	return [fakeBinDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...windowsHostToolDirs()].join(
		delimiter,
	);
}

// shortcut: Windows gets only git and System32, so specs that drive the POSIX fake bins (`central`, `code`, `gh`, the login shell) still fail there; port those stubs before making Windows a supported e2e host.
function windowsHostToolDirs(): string[] {
	if (process.platform !== "win32") return [];
	const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const git = directories.find((directory) => existsSync(join(directory, "git.exe")));
	const system32 = directories.find((directory) => /[\\/]system32[\\/]?$/i.test(directory));
	return [git, system32].filter((directory) => directory !== undefined);
}

export function hermeticE2eShell(fakeBinDir: string): string {
	return join(fakeBinDir, "login-shell");
}

export function writeHermeticE2eShell(fakeBinDir: string, realShell: string): void {
	const script = [
		"#!/bin/sh",
		'case "$*" in',
		`\t*${shellQuote(LOGIN_ENV_MARKER)}*) printf '%sPATH=%s\\0' ${shellQuote(LOGIN_ENV_MARKER)} ${shellQuote(hermeticE2ePath(fakeBinDir))}; exit 0 ;;`,
		"esac",
		`exec ${shellQuote(realShell)} "$@"`,
		"",
	].join("\n");
	const target = hermeticE2eShell(fakeBinDir);
	writeFileSync(target, script);
	chmodSync(target, 0o755);
}

export function writeFakeGh(fakeBinDir: string, scenarioPath: string, logPath: string): void {
	const source = fileURLToPath(new URL("./fakeGh.ts", import.meta.url));
	const script = [
		"#!/bin/sh",
		`exec ${[resolveBunExecutable(), source, scenarioPath, logPath].map(shellQuote).join(" ")} "$@"`,
		"",
	].join("\n");
	const target = join(fakeBinDir, "gh");
	writeFileSync(target, script);
	chmodSync(target, 0o755);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
