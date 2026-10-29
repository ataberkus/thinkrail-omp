import { expect, type Locator, test } from "@playwright/test";
import {
	createWorkspaceViaDialog,
	defaultWorkspaceRow,
	openAppFresh,
	openFixtureProject,
	PHONE_VIEWPORT,
} from "./fixtures/app";

async function box(locator: Locator) {
	const bounds = await locator.boundingBox();
	if (!bounds) throw new Error("element has no layout box");
	return bounds;
}

test("Project Home's projects pane is a phone sheet over a full-width welcome", async ({
	page,
}) => {
	await page.setViewportSize(PHONE_VIEWPORT);
	await openAppFresh(page);
	const layout = page.getByTestId("welcome-shell-layout");
	const addProject = page.getByTestId("add-project-menu");
	await expect(layout).toHaveAttribute("data-left-collapsed", "true");
	await expect(addProject).toBeHidden();
	const welcome = await box(page.getByTestId("welcome"));
	expect(welcome.x + welcome.width).toBeGreaterThanOrEqual(PHONE_VIEWPORT.width - 1);

	await page.getByTestId("tool-rail-projects").click();
	await expect(layout).toHaveAttribute("data-left-collapsed", "false");
	await addProject.click();
	await page.getByTestId("menu-open-project").click();
	await expect(page.getByTestId("project-item").first()).toBeVisible();

	await page.getByTestId("side-group-fold").click();
	await expect(layout).toHaveAttribute("data-left-collapsed", "true");
	await expect(addProject).toBeHidden();
});

test("a phone workbench shows sides as one tapped sheet that a file open closes", async ({
	page,
}) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await page.setViewportSize(PHONE_VIEWPORT);
	const sheet = page.getByTestId("phone-side-sheet");
	const filesRail = page.getByTestId("tool-rail-files");
	await expect(sheet).toHaveCount(0);

	await filesRail.click();
	await expect(sheet).toBeVisible();
	const center = await box(page.getByTestId("center-tabs"));
	const sheetBox = await box(sheet);
	expect(Math.abs(sheetBox.x - center.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(sheetBox.width - center.width)).toBeLessThanOrEqual(1);

	await filesRail.click();
	await expect(sheet).toHaveCount(0);

	await filesRail.click();
	await sheet.getByTestId("file-node").filter({ hasText: "notes.txt" }).dblclick();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByTestId("editor-tab").filter({ hasText: "notes.txt" })).toBeVisible();

	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(sheet).toHaveCount(0);
	await expect(page.getByTestId("file-node").filter({ hasText: "notes.txt" })).toBeVisible();
});

test("a phone sheet closes on Hide and a workspace switch, and re-entering phone width starts closed", async ({
	page,
}) => {
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await page.setViewportSize(PHONE_VIEWPORT);
	const sheet = page.getByTestId("phone-side-sheet");
	const projectsRail = page.getByTestId("tool-rail-projects");

	await projectsRail.click();
	await expect(sheet).toBeVisible();
	await sheet.getByTestId("side-group-fold").first().click();
	await expect(sheet).toHaveCount(0);

	await projectsRail.click();
	await expect(sheet).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(sheet).toHaveCount(0);
	await expect(page.getByTestId("left-stack")).toBeVisible();
	await page.setViewportSize(PHONE_VIEWPORT);
	await expect(page.getByTestId("left-stack")).toHaveCount(0);
	await expect(sheet).toHaveCount(0);

	await projectsRail.click();
	await sheet.locator(defaultWorkspaceRow(page)).click();
	await expect(sheet).toHaveCount(0);
	await projectsRail.click();
	await expect(defaultWorkspaceRow(page)).toHaveAttribute("data-active", "true");
});
