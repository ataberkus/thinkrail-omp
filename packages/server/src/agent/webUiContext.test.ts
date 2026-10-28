import { expect, test } from "bun:test";
import { Theme } from "@oh-my-pi/pi-coding-agent";
import type { ExtUiRequest } from "@thinkrail/contracts";
import {
	cancelExtUiForSession,
	createWebUiContext,
	notifyExtensionError,
	resolveExtUi,
	selectForToolCall,
	setExtUiPublisher,
} from "./webUiContext";

const ESC = "\u001b";

test("extension-UI bridge: confirm round-trips, a cancel resolves undefined, dispose dismisses", async () => {
	const frames: ExtUiRequest[] = [];
	setExtUiPublisher((f) => frames.push(f));
	const lastFrame = (): ExtUiRequest => {
		const f = frames.at(-1);
		if (!f) throw new Error("expected an ext-ui frame to have been pushed");
		return f;
	};
	const ui = createWebUiContext("sess-extui");

	const confirmP = ui.confirm("Proceed?", "Apply the change?");
	const confirmFrame = lastFrame();
	expect(confirmFrame.kind).toBe("confirm");
	expect(confirmFrame.sessionId).toBe("sess-extui");
	resolveExtUi({ id: confirmFrame.id, value: true });
	expect(await confirmP).toBe(true);

	const selectP = ui.select("Pick one", ["a", "b"]);
	resolveExtUi({ id: lastFrame().id, value: null });
	expect(await selectP).toBeUndefined();

	const inputP = ui.input("Name?");
	const inputFrame = lastFrame();
	cancelExtUiForSession("sess-extui");
	expect(await inputP).toBeUndefined();
	expect(frames.some((f) => f.kind === "dismiss" && f.id === inputFrame.id)).toBe(true);

	setExtUiPublisher(() => {});
});

test("extension-UI bridge: a dialog names the running tool call it is about, if any", async () => {
	const frames: ExtUiRequest[] = [];
	setExtUiPublisher((f) => frames.push(f));
	let running: string | undefined = "call-7";
	const ui = createWebUiContext("sess-anchor", () => running);

	const anchored = ui.confirm("Run rm?", "It deletes files.");
	expect(frames.at(-1)).toMatchObject({ kind: "confirm", toolCallId: "call-7" });
	running = undefined;
	const loose = ui.input("Paste the code");
	expect(frames.at(-1)).not.toHaveProperty("toolCallId");
	const explicit = selectForToolCall(
		"sess-anchor",
		{ toolCallId: "call-9", toolInput: { path: "/etc/hosts" } },
		"Allow?",
		["Deny", "Allow once"],
	);
	expect(frames.at(-1)).toMatchObject({
		kind: "select",
		toolCallId: "call-9",
		toolInput: { path: "/etc/hosts" },
	});
	resolveExtUi({ id: frames.at(-1)?.id ?? "", value: "Allow once" });
	expect(await explicit).toBe("Allow once");

	cancelExtUiForSession("sess-anchor");
	expect(await anchored).toBe(false);
	expect(await loose).toBeUndefined();
	setExtUiPublisher(() => {});
});

const THEME_CALLS: Record<string, (theme: Theme) => unknown> = {
	getColorHex: (t) => t.getColorHex("accent"),
	getBgHex: (t) => t.getBgHex("selectedBg"),
	getAllThemeColorHexes: (t) => t.getAllThemeColorHexes(),
	getMajorThemeColorHexes: (t) => t.getMajorThemeColorHexes(),
	getAccentColorHex: (t) => t.getAccentColorHex(),
	hasColor: (t) => t.hasColor("accent"),
	fg: (t) => t.fg("accent", "Theme works"),
	fgResolved: (t) => t.fgResolved("accent", "Theme works"),
	bg: (t) => t.bg("selectedBg", "Theme works"),
	bgFill: (t) => t.bgFill("selectedBg", "Theme works"),
	fgOnBg: (t) => t.fgOnBg("accent", "selectedBg", "Theme works"),
	bold: (t) => t.bold("Theme works"),
	italic: (t) => t.italic("Theme works"),
	underline: (t) => t.underline("Theme works"),
	strikethrough: (t) => t.strikethrough("Theme works"),
	inverse: (t) => t.inverse("Theme works"),
	getFgAnsi: (t) => t.getFgAnsi("accent"),
	getBgAnsi: (t) => t.getBgAnsi("selectedBg"),
	getFgOnBgAnsi: (t) => t.getFgOnBgAnsi("accent", "selectedBg"),
	getContrastFgAnsi: (t) => t.getContrastFgAnsi("accent"),
	getColorMode: (t) => t.getColorMode(),
	getThinkingBorderColor: (t) => t.getThinkingBorderColor("high")("Theme works"),
	getBashModeBorderColor: (t) => t.getBashModeBorderColor()("Theme works"),
	getPythonModeBorderColor: (t) => t.getPythonModeBorderColor()("Theme works"),
	symbol: (t) => t.symbol("status.success"),
	styledSymbol: (t) => t.styledSymbol("status.success", "success"),
	getSymbolPreset: (t) => t.getSymbolPreset(),
	getSpinnerFrames: (t) => t.getSpinnerFrames(),
	getLangIcon: (t) => t.getLangIcon("typescript"),
	getLangIconStyled: (t) => t.getLangIconStyled("typescript"),
};

const PLAIN_METHODS = [
	"fg",
	"fgResolved",
	"bg",
	"bgFill",
	"fgOnBg",
	"bold",
	"italic",
	"underline",
	"strikethrough",
	"inverse",
	"getThinkingBorderColor",
	"getBashModeBorderColor",
	"getPythonModeBorderColor",
];

const ANSI_METHODS = ["getFgAnsi", "getBgAnsi", "getFgOnBgAnsi", "getContrastFgAnsi"];

function prototypeMembers(kind: "method" | "getter"): string[] {
	return Object.getOwnPropertyNames(Theme.prototype).filter((name) => {
		if (name === "constructor") return false;
		const isGetter = Object.getOwnPropertyDescriptor(Theme.prototype, name)?.get !== undefined;
		return kind === "getter" ? isGetter : !isGetter;
	});
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}

test("theme: omp's Theme contract is implemented and every decorator yields plain text", () => {
	const { theme } = createWebUiContext("sess-theme");

	expect(theme).toBeInstanceOf(Theme);
	for (const name of prototypeMembers("method")) {
		expect(typeof Reflect.get(theme, name)).toBe("function");
	}
	for (const name of PLAIN_METHODS) expect(THEME_CALLS[name]?.(theme)).toBe("Theme works");
	for (const name of ANSI_METHODS) expect(THEME_CALLS[name]?.(theme)).toBe("");
});

test("theme: the whole inherited surface is exercised, and nothing it renders carries terminal escapes", () => {
	const { theme } = createWebUiContext("sess-theme-ansi");

	expect(Object.keys(THEME_CALLS).sort()).toEqual(prototypeMembers("method").sort());
	for (const [name, call] of Object.entries(THEME_CALLS)) {
		for (const out of strings(call(theme))) {
			if (out.includes(ESC))
				throw new Error(`${name} rendered a terminal escape: ${JSON.stringify(out)}`);
		}
	}
	for (const name of prototypeMembers("getter")) {
		for (const out of strings(Reflect.get(theme, name))) {
			if (out.includes(ESC))
				throw new Error(`${name} carries a terminal escape: ${JSON.stringify(out)}`);
		}
	}
	expect(theme.styledSymbol("status.success", "success")).toBe(theme.symbol("status.success"));
	expect(theme.getLangIconStyled("typescript")).toBe(theme.getLangIcon("typescript"));
});

test("theme: the context's theme queries answer like omp's own rpc mode", async () => {
	const ui = createWebUiContext("sess-theme-queries");

	expect(await ui.getAllThemes()).toEqual([]);
	expect(await ui.getTheme("dark")).toBeUndefined();
});

test("select: an option with a description is offered, and answered, by its label", async () => {
	const frames: ExtUiRequest[] = [];
	setExtUiPublisher((f) => frames.push(f));
	const ui = createWebUiContext("sess-select-items");

	const picked = ui.select("Pick", ["plain", { label: "Rich", description: "with detail" }]);
	expect(frames.at(-1)).toMatchObject({ kind: "select", options: ["plain", "Rich"] });
	resolveExtUi({ id: frames.at(-1)?.id ?? "", value: "Rich" });
	expect(await picked).toBe("Rich");

	setExtUiPublisher(() => {});
});

test("no member of the context is left undefined", () => {
	const ui = createWebUiContext("sess-members");

	for (const [key, value] of Object.entries(ui)) {
		expect(value).toBeDefined();
		if (key !== "theme") expect(typeof value).toBe("function");
	}
});

test("an extension error reaches the client with the extension, the event and the cause", () => {
	const frames: ExtUiRequest[] = [];
	setExtUiPublisher((f) => frames.push(f));

	notifyExtensionError("sess-err", {
		extensionPath: "/home/u/.pi/agent/extensions/theme-probe.ts",
		event: "session_start",
		error: "theme.fg is not a function",
		stack: "unused",
	});

	expect(frames.at(-1)).toMatchObject({
		sessionId: "sess-err",
		kind: "notify",
		level: "error",
		message: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
	});

	setExtUiPublisher(() => {});
});

test("an extension error is bounded and named by its directory when the file is anonymous", () => {
	const frames: ExtUiRequest[] = [];
	setExtUiPublisher((f) => frames.push(f));

	notifyExtensionError("sess-err", {
		extensionPath: "/home/u/.pi/agent/extensions/branch-status/SKILL.md",
		event: "turn_start",
		error: "x".repeat(5_000),
	});

	const frame = frames.at(-1);
	if (frame?.kind !== "notify") throw new Error("expected a notify frame");
	expect(frame.message.startsWith("Extension branch-status failed on turn_start: ")).toBe(true);
	expect(frame.message.length).toBeLessThan(600);
	expect(frame.message.endsWith("…")).toBe(true);

	setExtUiPublisher(() => {});
});
