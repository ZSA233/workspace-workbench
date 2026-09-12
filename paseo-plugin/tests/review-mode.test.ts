import assert from "node:assert/strict";
import test from "node:test";
import { effectiveReviewMode } from "../client/review-mode.ts";

test("compact panels force unified without overwriting the wide-panel preference", () => {
  assert.equal(effectiveReviewMode(true, "split"), "unified");
  assert.equal(effectiveReviewMode(true, "unified"), "unified");
  assert.equal(effectiveReviewMode(false, "split"), "split");
  assert.equal(effectiveReviewMode(false, "unified"), "unified");
  assert.equal(effectiveReviewMode(false, null), "split");
});
