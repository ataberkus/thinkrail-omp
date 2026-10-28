import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionSessionServices } from "@thinkrail/extension-api/server";
import { type ServerExtensionEntry, serverExtensions } from "./registry";

export type RegistryExtensionKind = "extensions" | "childExtensions";
export type ExtensionDisabled = (name: string) => boolean;

export type RegistryExtensionFactory = ExtensionFactory & { readonly registryName: string };

const never: ExtensionDisabled = () => false;

const toolOwners = new Map<string, string>();

function factoriesOf(
	entry: ServerExtensionEntry,
	kind: RegistryExtensionKind,
	session: ExtensionSessionServices | undefined,
): ExtensionFactory[] {
	const { extension } = entry;
	if (kind === "childExtensions") return extension.childExtensions ?? [];
	const perSession =
		session && extension.sessionExtensions ? extension.sessionExtensions(session) : [];
	return [...extension.extensions, ...perSession];
}

function recordingOwnership(pi: ExtensionAPI, owner: string): ExtensionAPI {
	return new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") {
				const register: ExtensionAPI["registerTool"] = (tool) => {
					toolOwners.set(tool.name, owner);
					target.registerTool(tool);
				};
				return register;
			}
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function registryInlineExtensions(
	kind: RegistryExtensionKind,
	isDisabled: ExtensionDisabled = never,
	entries: readonly ServerExtensionEntry[] = serverExtensions,
	session?: ExtensionSessionServices,
	onLoaded?: (name: string) => void,
): RegistryExtensionFactory[] {
	return entries.flatMap((entry) => {
		const { name } = entry.extension;
		return factoriesOf(entry, kind, session).map((factory) => {
			const wrapped: ExtensionFactory = async (pi) => {
				if (isDisabled(name)) return;
				onLoaded?.(name);
				await factory(recordingOwnership(pi, name));
			};
			return Object.assign(wrapped, { registryName: name });
		});
	});
}

export function registryToolOwner(toolName: string): string | undefined {
	return toolOwners.get(toolName);
}
