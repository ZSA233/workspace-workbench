import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { localPaseoEndpoint } = require("../shared/paseo-endpoint.mjs") as { localPaseoEndpoint: () => string };

test("local Paseo endpoint accepts local and wildcard daemon listeners", () => {
  const home = mkdtempSync(join(tmpdir(), "workbench-paseo-endpoint-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    writeFileSync(join(home, "paseo.pid"), JSON.stringify({ listen: "0.0.0.0:6767" }));
    assert.equal(localPaseoEndpoint(), "ws://127.0.0.1:6767/ws");
    writeFileSync(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6768" }));
    assert.equal(localPaseoEndpoint(), "ws://127.0.0.1:6768/ws");
    writeFileSync(join(home, "paseo.pid"), JSON.stringify({ listen: "[::1]:6769" }));
    assert.equal(localPaseoEndpoint(), "ws://[::1]:6769/ws");
    writeFileSync(join(home, "paseo.pid"), JSON.stringify({ listen: "192.168.1.20:6770" }));
    assert.equal(localPaseoEndpoint(), "");
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
