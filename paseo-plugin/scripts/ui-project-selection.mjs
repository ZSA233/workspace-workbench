/** The global entry has no workspace context, so test fixtures choose explicitly. */
export async function selectGlobalWorkbenchProject(page, projectName) {
  const chooser = page.getByText(/^(Select project|选择项目)$/).filter({ visible: true }).first();
  const repositories = page.getByText(/^(Repositories|仓库)$/).filter({ visible: true }).first();
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

/** Fresh isolated homes can require direct connection and onboarding before the plugin entry. */
export async function openIsolatedWorkbench(page, url, projectName) {
  await page.goto(url);
  const direct=page.getByText(/^(Direct connection|直接连接)$/).first();
  if(await direct.isVisible().catch(()=>false)){
    await direct.click();await page.getByPlaceholder('localhost',{exact:true}).fill('127.0.0.1');
    await page.getByPlaceholder('6767',{exact:true}).fill(new URL(url).port);
    await page.getByRole('button',{name:/^(Connect|连接)$/,exact:true}).click();
  }
  const skip=page.getByRole('button',{name:/^(Skip setup|跳过设置)$/,exact:true});
  await Promise.race([skip.waitFor().catch(()=>{}),page.getByRole('button',{name:'Workspace Workbench',exact:true}).first().waitFor()]);
  if(await skip.isVisible().catch(()=>false))await skip.click();
  await openGlobalWorkbench(page,projectName);
}
