import { useT } from "@thinkrail/locales/react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@thinkrail/ui/resizable";
import { useState } from "react";
import { QuietScrollArea } from "../components/QuietScrollArea";
import { usePhoneViewport } from "../lib";
import { ProjectTree } from "../panels/ProjectTree";
import { WelcomePanel } from "../panels/WelcomePanel";
import {
	AuxiliaryPaneHeader,
	AuxiliaryPaneHideButton,
	AuxiliaryRail,
	AuxiliaryRailToolButton,
	type AuxiliaryRailToolEntry,
	DEFAULT_LAYOUT_PRESET_ID,
	resolveLayoutPreset,
} from "./layout";
import type { CollapsibleRegion } from "./useCollapsibleRegion";

export const PROJECT_HOME_PROJECTS_REGION_ID = "welcome-left";
const PROJECT_HOME_AUTOSAVE_ID = "thinkrail-shell-welcome";
const PROJECTS_PANE_ID = "project-home-projects";
const PROJECTS_RAIL_ENTRY_KEY = "projects";
const PROJECTS_PANE_DEFAULT_PERCENT =
	resolveLayoutPreset(DEFAULT_LAYOUT_PRESET_ID, []).left.width * 100;
const PROJECTS_PANE_MIN_PERCENT = 12;
const WELCOME_MIN_PERCENT = 40;

export function ProjectHome({ projects }: { projects: CollapsibleRegion<HTMLDivElement> }) {
	const t = useT();
	const {
		collapsed,
		contentRef,
		onCollapse,
		onDragging,
		onExpand,
		panelRef,
		railRef,
		regionRef,
		toggle,
	} = projects;
	const phone = usePhoneViewport();
	const [sheetOpen, setSheetOpen] = useState(false);
	const [sheetPhone, setSheetPhone] = useState(phone);
	if (sheetPhone !== phone) {
		setSheetPhone(phone);
		setSheetOpen(false);
	}
	const projectsShown = phone ? sheetOpen : !collapsed;
	const toggleProjects = phone ? () => setSheetOpen(!sheetOpen) : toggle;
	const entry: AuxiliaryRailToolEntry = {
		key: PROJECTS_RAIL_ENTRY_KEY,
		region: "left",
		kind: "tool",
		groupId: null,
		tool: "projects",
		tab: null,
		selected: true,
		expanded: projectsShown,
	};
	const projectsPane = (
		<section
			ref={regionRef}
			id={PROJECTS_PANE_ID}
			aria-label={t("shell.projectHome.projects")}
			aria-hidden={!projectsShown || undefined}
			inert={!projectsShown ? true : undefined}
			className="flex h-full min-h-0 flex-col bg-container-sidebar-bg"
		>
			<AuxiliaryPaneHeader
				title={t("shell.projectHome.projects")}
				actions={
					<AuxiliaryPaneHideButton
						testId="side-group-fold"
						controls={PROJECTS_PANE_ID}
						onClick={toggleProjects}
					/>
				}
			/>
			<div ref={contentRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
				<QuietScrollArea
					data-testid="left-nav"
					className="min-h-0 flex-1"
					viewportClassName="p-panel-inset"
				>
					<ProjectTree />
				</QuietScrollArea>
			</div>
		</section>
	);
	const welcome = (
		<div className="h-full min-h-0 bg-container-content-bg">
			<WelcomePanel />
		</div>
	);
	return (
		<div
			data-testid="welcome-shell-layout"
			data-left-collapsed={!projectsShown}
			className="flex h-full min-h-0 min-w-0"
		>
			<AuxiliaryRail
				region="left"
				entries={[entry]}
				renderEntry={(_, control) => (
					<AuxiliaryRailToolButton
						ref={railRef}
						entry={entry}
						controls={PROJECTS_PANE_ID}
						control={control}
						onActivate={toggleProjects}
					/>
				)}
			/>
			{phone ? (
				<div className="relative min-h-0 min-w-0 flex-1">
					{welcome}
					{sheetOpen ? <div className="absolute inset-0 z-20 shadow-lg">{projectsPane}</div> : null}
				</div>
			) : (
				<ResizablePanelGroup
					direction="horizontal"
					autoSaveId={PROJECT_HOME_AUTOSAVE_ID}
					className="min-h-0 min-w-0 flex-1"
				>
					<ResizablePanel
						ref={panelRef}
						id="left"
						order={1}
						defaultSize={PROJECTS_PANE_DEFAULT_PERCENT}
						minSize={PROJECTS_PANE_MIN_PERCENT}
						collapsedSize={0}
						collapsible
						onCollapse={onCollapse}
						onExpand={onExpand}
					>
						{projectsPane}
					</ResizablePanel>
					<ResizableHandle
						direction="horizontal"
						data-testid="resize-left"
						aria-hidden={collapsed}
						tabIndex={collapsed ? -1 : 0}
						onDragging={onDragging}
						{...(collapsed ? { className: "hidden" } : {})}
					/>
					<ResizablePanel
						id="welcome"
						order={2}
						defaultSize={100 - PROJECTS_PANE_DEFAULT_PERCENT}
						minSize={WELCOME_MIN_PERCENT}
					>
						{welcome}
					</ResizablePanel>
				</ResizablePanelGroup>
			)}
		</div>
	);
}
