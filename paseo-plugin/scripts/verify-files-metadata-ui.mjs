import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Read-only metadata inspection in verify-live's isolated project only. */
export async function verifyFilesMetadataUi({ page, ui, rpc, output, report, check }) {
  assert.match(ui.project, /^\/(?:private\/)?tmp\/wb-live-[^/]+\/a$/);
  const directory = join(ui.project, '.workspace-workbench'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'readonly-proof.txt'), 'Read-only metadata inspection proof\n');
  const row = path => page.locator(`[data-file-path="${path}"]`).filter({ visible: true });
  await page.getByRole('button', { name: '↻ Refresh', exact: true }).click();
  await row('.workspace-workbench').waitFor();
  if (await row('one').getByRole('button').getAttribute('aria-expanded') !== 'true') await row('one').click();
  await row('one/.git').waitFor();
  assert.match(await row('one/.git').innerText(), /Read only/);
  if (await row('one/.git').getByRole('button').getAttribute('aria-expanded') !== 'true') await row('one/.git').click();
  await row('one/.git/HEAD').waitFor();
  assert.match(await row('one/.git/HEAD').innerText(), /Read only/);
  const head = await rpc({ action: 'document', workspaceId: 'main', path: 'one/.git/HEAD' });
  assert.equal(head.readOnly, true); assert.match(head.text, /ref: refs\/heads\//);
  await row('one/.git/HEAD').click({ button: 'right' });
  for (const name of ['Upload here', 'New folder', 'Paste here', 'Rename', 'Delete permanently…', 'Cut', 'Copy', 'Download / ZIP'])
    assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.getByText('File actions', { exact: true }).waitFor({ state: 'hidden' });
  await row('.workspace-workbench').click(); await row('.workspace-workbench/readonly-proof.txt').waitFor();
  assert.match(await row('.workspace-workbench/readonly-proof.txt').innerText(), /Read only/);
  await row('.workspace-workbench').click({ button: 'right' });
  await page.getByRole('button', { name: 'Browse this folder', exact: true }).click();
  await page.getByText('File actions', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByText('Internal data · read only', { exact: false }).filter({ visible: true }).first().waitFor();
  for (const name of ['↑ Upload', 'Upload folder', '+ Folder'])
    assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(output, 'metadata-readonly-tree.png') }); report.screenshots.push('metadata-readonly-tree.png');
  check('Git and Workbench metadata expand in the real file tree, expose read-only badges and keep write controls disabled');
  await row('.workspace-workbench/readonly-proof.txt').dblclick();
  await page.getByText('Read-only metadata inspection proof', { exact: false }).filter({ visible: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download', exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(output, 'metadata-readonly-document.png') }); report.screenshots.push('metadata-readonly-document.png');
  await page.getByRole('button', { name: 'Back to files', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace Workbench', exact: true }).first().click();
  const files = page.getByRole('tab', { name: 'Files', exact: true });
  const chooser = page.getByText(/^(Select project|选择项目)$/).filter({ visible: true }).first();
  const state = await Promise.race([files.waitFor().then(() => 'ready'), chooser.waitFor().then(() => 'choose')]);
  if (state === 'choose') await page.getByText('a', { exact: true }).filter({ visible: true }).last().click();
  await files.click();
  await page.getByRole('button', { name: 'Workspace root', exact: true }).click();
  await row('one').waitFor();
  assert.equal(await page.getByRole('button', { name: '↑ Upload', exact: true }).isDisabled(), false);
  check('metadata documents open read-only, and returning to ordinary project files restores writable controls');
}
