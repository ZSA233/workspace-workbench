import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectPocket, type PocketExtensionClient } from "../client/pocket-sdk/index.ts";

test("Pocket SDK is optional on ordinary browsers, native Paseo and older shells", () => {
  const target = globalThis as any, previous = target.Pocket;
  try {
    delete target.Pocket; assert.equal(connectPocket({ paseo: {} }), null);
    target.Pocket = { protocolVersion: 2, connect() { throw Error('must not connect incompatible protocol'); } };
    assert.equal(connectPocket({ paseo: {} }), null);
    target.Pocket = { protocolVersion: 1, connect() { throw Error('optional adapter unavailable'); } };
    assert.equal(connectPocket({ paseo: {} }), null);
    const client = { paseo: {} }, api = {} as PocketExtensionClient;
    target.Pocket = { protocolVersion: 1, connect(value: unknown) { assert.equal(value, client); return api; } };
    assert.equal(connectPocket(client), api);
  } finally { if (previous === undefined) delete target.Pocket; else target.Pocket = previous; }
});

test("the public SDK has no renderer, browser selector or native runtime dependency", () => {
  const source = readFileSync(new URL('../client/pocket-sdk/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ["'](?:react|react-native|@getpaseo)/);
  assert.doesNotMatch(source, /querySelector|__r\b|__d\b|WebView|workspace-workbench/);
});
