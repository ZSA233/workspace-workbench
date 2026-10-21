import { randomUUID } from 'node:crypto';
import { adb } from './device-browser.mjs';
const decode = s => s.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
export async function uiNodes(serial) {
  const path = `/sdcard/pocket-fixture-ui-${randomUUID()}.xml`;
  try {
    await adb(serial, ['shell', 'uiautomator', 'dump', path]);
    const xml = await adb(serial, ['shell', 'cat', path]);
    return [...xml.matchAll(/<node\b[^>]*>/g)].map(row => Object.fromEntries(
      [...row[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])])));
  } finally { await adb(serial, ['shell', 'rm', path]); }
}
export async function tapNode(serial, predicate) {
  const node = (await uiNodes(serial)).find(predicate);
  if (!node) throw new Error('Native test control is missing');
  const coordinates = node.bounds.match(/\d+/g).map(Number);
  await adb(serial, ['shell', 'input', 'tap', String(Math.round((coordinates[0]+coordinates[2])/2)), String(Math.round((coordinates[1]+coordinates[3])/2))]);
  await new Promise(r => setTimeout(r, 300));
}
