import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { removeTree } from "@thinkrail/shared/removeTree";
import { E2E_DATA_DIR } from "./paths";

const HELD_BY_LIVE_HOST: readonly unknown[] = ["EBUSY", "EPERM", "EACCES"];

function removeUnheld(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
		return;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && HELD_BY_LIVE_HOST.includes(error.code))) {
			throw error;
		}
	}
	let entries: string[];
	try {
		entries = readdirSync(path);
	} catch {
		return;
	}
	for (const entry of entries) removeUnheld(join(path, entry));
}

export function clearE2eDataDir(): void {
	if (process.platform === "win32") removeUnheld(E2E_DATA_DIR);
	else removeTree(E2E_DATA_DIR);
}

if (import.meta.main) removeTree(E2E_DATA_DIR);
