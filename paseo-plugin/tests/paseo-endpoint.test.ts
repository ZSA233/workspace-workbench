import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { localPaseoEndpoint } = require("../server/paseo-endpoint.mjs") as { localPaseoEndpoint: () => string };

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

test('endpoint normalization covers Unix and IPv6 wildcard listeners and rejects invalid ports', async () => {
  const { normalizePaseoEndpoint } = await import('../shared/paseo-endpoint.mjs');
  for (const [input, expected] of [
    ['unix:///tmp/paseo.sock', 'ws+unix:///tmp/paseo.sock:/ws'],
    ['[::]:6767', 'ws://localhost:6767/ws'],
    ['localhost:6767', 'ws://localhost:6767/ws'],
    ['0.0.0.0:0', ''], ['127.0.0.1:65536', ''], ['remote.example:6767', ''],
  ]) assert.equal(normalizePaseoEndpoint(input), expected);
});
