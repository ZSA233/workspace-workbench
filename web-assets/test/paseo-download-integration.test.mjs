import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { integrateDownloadHandoff } from "../recipes/paseo/web/integrate-download.mjs";

const storePath = "stores/download-store.ts";
const toastPath = "components/download-toast.tsx";
const englishPath = "i18n/resources/en.ts";
const downloadStore = `import { create } from 'zustand';
interface Download { status: 'downloading' | 'complete' | 'error' }
const store = create((set) => ({
  startDownload: async ({ requestFileDownloadToken, fileName, path }) => {
    try {
      const response = await requestFileDownloadToken(path);
      if (!response.token) throw new Error('Missing token');
      const selectedName = response.fileName
        ?? fileName;
      const target = resolveDaemonDownloadTarget();
      await existingDownload(target, selectedName);
    } catch (error) {
      showError(error);
    }
  },
}));`;
const downloadToast = `import { XCircle } from 'lucide-react-native';
function getDownloadStatusText(file, t) {
  if (file.status === 'complete') return t('complete');
  return file.message;
}
const render = (file) => <View>{file.status === 'error' ? <XCircle /> : null}</View>;`;

async function fixture(t, store = downloadStore) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-download-recipe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, "packages/app/src");
  await Promise.all([
    [storePath, store],
    [toastPath, downloadToast],
    [englishPath, "export const en = { downloads: { failed: 'Failed' } };"],
    ["i18n/resources/pl.ts", "export const pl = { downloads: { failed: 'Błąd' } };"],
    ["i18n/resources/unrelated.ts", "export const resources = {};"],
  ].map(async ([name, contents]) => {
    const file = join(app, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }));
  return { directory, read: (name) => readFile(join(app, name), "utf8") };
}

test("the adaptation survives moved imports, renamed bindings, and a new locale", async (t) => {
  const project = await fixture(t, "// Source header\n" + downloadStore);
  await integrateDownloadHandoff(project.directory);
  const store = await project.read(storePath);
  assert.match(store, /^\/\/ Source header\nimport \{ tryAccessDownload \}/);
  assert.match(store, /Missing token[\s\S]*tryAccessDownload\(\{[\s\S]*token: response\.token,[\s\S]*filename: selectedName,[\s\S]*await existingDownload\(target, selectedName\)/);
  assert.match(await project.read(toastPath), /file\.status === "delegated"[\s\S]*downloads\.handedOff/);
  assert.match(await project.read("i18n/resources/pl.ts"), /handedOff: "Handed to the system download manager"/);
  assert.equal(await project.read("i18n/resources/unrelated.ts"), "export const resources = {};");
});

test("an unrecognized token flow stops the adaptation without edits", async (t) => {
  const original = downloadStore.replace("if (!response.token) throw new Error('Missing token');", "");
  const project = await fixture(t, original);
  await assert.rejects(integrateDownloadHandoff(project.directory), /expected a checked token/);
  assert.equal(await project.read(storePath), original);
  assert.equal(await project.read(toastPath), downloadToast);
});
