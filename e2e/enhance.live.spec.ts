import { expect, test } from "@playwright/test";
import { openWorkspaceChat } from "./fixtures/app";

const DRAFT = "add search to the feature list in the project json";

test("✨ Enhance reads the repository, shows its lookups and grounds the rewrite", {
	tag: "@agent",
}, async ({ page }) => {
	test.setTimeout(240_000);
	await openWorkspaceChat(page);
	const input = page.getByTestId("chat-input");
	await input.fill(DRAFT);
	await page.getByTestId("composer-enhance").click();

	const status = page.getByTestId("composer-enhance-status");
	await expect(status).toBeVisible();
	await expect(status).toHaveText(/^(Reading|Searching for|Listing) .+…$/, { timeout: 120_000 });

	await expect(input).not.toHaveValue(DRAFT, { timeout: 200_000 });
	await expect(status).toBeHidden();
	await expect(input).toHaveValue(/sample\.json/);
	await expect(input).toHaveValue(/features/);
});

test("✨ Enhance cancels on a second click and keeps the draft", {
	tag: "@agent",
}, async ({ page }) => {
	test.setTimeout(60_000);
	await openWorkspaceChat(page);
	const input = page.getByTestId("chat-input");
	await input.fill(DRAFT);
	const control = page.getByTestId("composer-enhance");
	await control.click();
	await expect(control).toHaveAttribute("data-running", "true");
	await control.click();
	await expect(page.getByTestId("composer-enhance-status")).toBeHidden();
	await expect(control).not.toHaveAttribute("data-running", "true");
	await expect(input).toHaveValue(DRAFT);
	await expect(input).toBeEditable();
});
