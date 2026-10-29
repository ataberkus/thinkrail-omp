import { removeTree } from "@thinkrail/shared/removeTree";
import { clearE2eDataDir } from "./fixtures/dataDir";
import { E2E_BINARY_CACHE, E2E_DESKTOP_CACHE } from "./fixtures/paths";

export default function globalTeardown(): void {
	clearE2eDataDir();
	removeTree(E2E_BINARY_CACHE);
	removeTree(E2E_DESKTOP_CACHE);
}
