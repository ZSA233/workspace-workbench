/** The global entry has no workspace context, so test fixtures choose explicitly. */
export async function selectGlobalWorkbenchProject(page, projectName) {
  const chooser = page.getByText("Select project", { exact: true }).filter({ visible: true }).first();
  const repositories = page.getByText("Repositories", { exact: true }).filter({ visible: true }).first();
  const state = await Promise.race([
    chooser.waitFor({ timeout: 30000 }).then(() => "choose"),
    repositories.waitFor({ timeout: 30000 }).then(() => "ready"),
  ]);
  if (state === "choose") {
    await page.getByText(projectName, { exact: true }).filter({ visible: true }).last().click();
    await repositories.waitFor({ timeout: 30000 });
  }
}

export async function openGlobalWorkbench(page, projectName) {
  await page.getByRole("button", { name: "Workspace Workbench", exact: true }).first().click();
  await selectGlobalWorkbenchProject(page, projectName);
}
