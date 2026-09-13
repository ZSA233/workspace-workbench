import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const versionTools: any = await import(new URL("../../scripts/version.mjs", import.meta.url).href);
const { bumpedVersion, checkMetadata, setVersion } = versionTools;

test("Node release metadata checker validates and updates the coordinated plugin version", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-version-"));
  try {
    const plugin = join(root, "paseo-plugin");
    const sourcePlugin = resolve(import.meta.dirname, "..");
    const version = readFileSync(resolve(import.meta.dirname, "../../VERSION"), "utf8");
    // Copy only metadata; the test never edits the repository checkout.
    mkdirSync(plugin, { recursive: true });
    copyFileSync(join(sourcePlugin, "package.json"), join(plugin, "package.json"));
    copyFileSync(join(sourcePlugin, "package-lock.json"), join(plugin, "package-lock.json"));
    writeFileSync(join(root, "VERSION"), version);
    assert.deepEqual(await checkMetadata(root), []);
    assert.equal(bumpedVersion("0.1.3", "patch"), "0.1.4");
    assert.equal(bumpedVersion("0.1.3", "minor"), "0.2.0");
    assert.equal(bumpedVersion("0.1.3", "major"), "1.0.0");
    await setVersion(root, "0.1.4");
    assert.deepEqual(await checkMetadata(root), []);
    assert.equal(JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")).version, "0.1.4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
