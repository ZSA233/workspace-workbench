import assert from 'node:assert/strict';
import { join } from 'node:path';

/** Runs only against verify-live's isolated host and registry. */
export async function verifyFileWorkspacesUi({ page, ui, created, rpc, output, report, check }) {
  const selector = page.getByTestId('workbench-workspace-selector-toggle');
  const toggle = page.getByRole('button', { name: 'Switch file workspace', exact: true });
  const filter = page.getByRole('textbox', { name: 'Filter loaded files or folders', exact: true });
  const choose = async label => { await toggle.click(); await page.getByRole('button', { name: label, exact: true }).click(); };
  await selector.click(); await page.getByTestId('workbench-workspace-list').getByText(created.displayName, { exact: true }).click();
  await page.locator('[data-file-path="one"]').waitFor();
  await filter.fill('one');
  await choose('Main workspace');
  await page.locator('[data-file-path="two"]').waitFor();
  assert.match(await selector.innerText(), new RegExp(created.displayName));
  assert.equal(await filter.inputValue(), '');
  await page.screenshot({ path: join(output, 'file-main-peek.png') }); report.screenshots.push('file-main-peek.png');
  await choose(`Selected Workspace · ${created.displayName}`);
  await page.locator('[data-file-path="one"]').waitFor();
  assert.equal(await filter.inputValue(), 'one');
  assert.equal(await page.locator('[data-file-path="two"]').count(), 0);
  await filter.fill('');
  check('file-only main/selected switching preserves the selected Workspace and each file tree filter');
  await choose('Main workspace');
  await toggle.click(); await page.getByRole('button', { name: 'File directory settings…', exact: true }).click();
  await page.getByRole('button', { name: 'Choose another directory…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Host directory path', exact: true }).fill(join(ui.project, 'one'));
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Choose this directory', exact: true }).click();
  await page.getByText(join(ui.project, 'one'), { exact: true }).filter({ visible: true }).waitFor();
  await page.screenshot({ path: join(output, 'file-directory-settings.png') }); report.screenshots.push('file-directory-settings.png');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('[data-file-path="README"]').waitFor();
  assert.equal((await rpc({ action: 'browser-settings' })).effectiveDirectory, join(ui.project, 'one'));
  assert.match(await selector.innerText(), new RegExp(created.displayName));
  check('host directory picker changes only the main file root, without editing project configuration or changing execution selection');
  await toggle.click(); await page.getByRole('button', { name: 'File directory settings…', exact: true }).click();
  await page.getByRole('button', { name: 'Automatic main directory', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('[data-file-path="two"]').waitFor();
  assert.equal((await rpc({ action: 'browser-settings' })).mainDirectory, null);
  check('resetting file directory settings restores the automatically detected project directory');
  // Restore the preconditions of the existing file-operation UI proof.
  await selector.click(); await page.getByTestId('workbench-workspace-list').getByText('Main workspace', { exact: true }).click();
  await page.locator('[data-file-path="one"]').waitFor();
}
