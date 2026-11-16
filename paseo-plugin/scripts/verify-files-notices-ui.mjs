import assert from 'node:assert/strict';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Real missing directories exercise background diagnostics in the isolated host. */
export async function verifyFileNoticesUi({ page, ui, output, report, check }) {
  const originalViewport = page.viewportSize();
  const filter = page.getByRole('textbox', { name: 'Filter loaded files or folders', exact: true });
  const notice = page.getByRole('button', { name: 'View file notice', exact: true });
  const footer = page.getByTestId('files-status-bar');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const geometry = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return Promise.all([page.locator('[data-file-path=""]'), page.locator('[data-file-path="one"]'), filter, footer].map(async row => {
      const box = await row.boundingBox(); assert.ok(box, 'file UI remains mounted'); return box;
    }));
  };
  const stationary = (before, after, action) => {
    for (let row = 0; row < before.length; row++) for (const axis of ['x', 'y', 'width', 'height'])
      assert.ok(Math.abs(before[row][axis] - after[row][axis]) < 0.1, `${action}: row ${row} ${axis} moved from ${before[row][axis]} to ${after[row][axis]}`);
  };
  for (const [name, viewport] of [['desktop', originalViewport], ['narrow', { width: 760, height: 900 }]]) {
    await page.setViewportSize(viewport);
    const relative = `zz-notice-communications-service-long-path-${name}`, directory = join(ui.project, relative);
    await mkdir(directory);
    try {
      await page.getByText('↻ Refresh', { exact: true }).click();
      const entry = page.locator(`[data-file-path="${relative}"]`);
      await entry.waitFor({ timeout: 15000 }); await entry.click();
      await pause(500);
      await filter.focus();
      const before = await geometry();
      await rmdir(directory);
      await notice.waitFor({ timeout: 15000 });
      assert.equal(await page.getByTestId('files-notice-details').count(), 0, 'background errors never open a dialog');
      assert.equal(await filter.evaluate(element => element === document.activeElement), true, 'background errors preserve input focus');
      assert.equal(await page.getByText(/ENOENT/).count(), 0, 'raw errors stay out of the file tree');
      const after = await geometry(); stationary(before, after, `${name} notice appears`);
      (report.noticeGeometry ||= []).push({ viewport, before, after });
      const screenshot = `files-notice-${name}.png`;
      await page.screenshot({ path: join(output, screenshot) }); report.screenshots.push(screenshot);

      // Keyboard activation must reach the status button, not the file tree's Enter shortcut.
      await notice.press('Enter');
      const details = page.getByTestId('files-notice-details'); await details.waitFor();
      assert.match(await details.innerText(), /ENOENT/);
      assert.ok((await details.innerText()).includes(relative), 'details retain the complete failed path');
      stationary(before, await geometry(), `${name} details open`);
      await mkdir(directory);
      await page.getByRole('button', { name: 'Refresh folders', exact: true }).click();
      await details.waitFor({ state: 'detached' }); await notice.waitFor({ state: 'detached', timeout: 15000 });
      stationary(before, await geometry(), `${name} refresh recovers`);
      check(`${name}: actual ENOENT keeps file rows, footer geometry and input focus stable; keyboard details and refresh recover normally`);

      // Repeat the same filesystem failure, then leave polling active after dismissal.
      await filter.focus(); await rmdir(directory); await notice.waitFor({ timeout: 15000 });
      if (name === 'desktop') await page.getByRole('button', { name: 'Dismiss file notice', exact: true }).click();
      else { await notice.click(); await page.getByRole('button', { name: 'Dismiss', exact: true }).click(); }
      await notice.waitFor({ state: 'detached' });
      await pause(6500);
      assert.equal(await notice.count(), 0, 'polling never resurfaces an ignored diagnostic');
      stationary(before, await geometry(), `${name} notice dismissed`);
      check(`${name}: inline and detail dismissal survive repeated background checks without changing file layout`);
    } finally {
      if (await page.getByTestId('files-notice-details').isVisible()) await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await mkdir(directory, { recursive: true });
      await page.getByText('↻ Refresh', { exact: true }).click();
      const entry = page.locator(`[data-file-path="${relative}"]`);
      if (await entry.isVisible() && await entry.getByRole('button').getAttribute('aria-expanded') === 'true') await entry.click();
      await rmdir(directory);
      await page.getByText('↻ Refresh', { exact: true }).click();
      await entry.waitFor({ state: 'detached', timeout: 15000 });
    }
  }
  await page.setViewportSize(originalViewport);
}
