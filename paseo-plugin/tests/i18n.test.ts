import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkbenchCopy,
  localizedReviewError,
  normalizeWorkbenchLocale,
  resolveWorkbenchLocale,
} from "../shared/copy.ts";

test("Workbench locale resolution supports explicit Chinese and English values", () => {
  assert.equal(normalizeWorkbenchLocale("zh"), "zh-CN");
  assert.equal(normalizeWorkbenchLocale("zh-Hans"), "zh-CN");
  assert.equal(normalizeWorkbenchLocale("en-GB"), "en-US");
  assert.equal(resolveWorkbenchLocale({ language: "zh-CN" }), "zh-CN");
  assert.equal(resolveWorkbenchLocale({ locale: "en-US" }), "en-US");
});

test("Agent Review copy localizes statuses, events, settings and reviewer defaults", () => {
  const zh = getWorkbenchCopy("zh-CN");
  const en = getWorkbenchCopy("en-US");
  assert.equal(zh.tabAgentReview, "Agent 审核");
  assert.equal(en.tabAgentReview, "Agent Review");
  assert.equal(zh.reviewStatusChanges, "需要修改");
  assert.equal(en.reviewStatusChanges, "Changes requested");
  assert.equal(zh.reviewEventQueued, "审核已排队");
  assert.equal(en.reviewEventQueued, "Review queued");
  assert.equal(zh.reviewDefaultInstructions, "检查需求是否满足、实现是否正确、是否引入回归、测试是否充分；保持实现简单。");
  assert.equal(en.reviewDefaultInstructions, "Check requirement fit, correctness, regressions and tests; keep the implementation simple.");
  assert.equal(zh.agentSessionSettings, "Agent 会话设置");
  assert.equal(en.agentSessionSettings, "Agent session settings");
  assert.equal(localizedReviewError({ code: "review_snapshot_stale" }, zh), zh.reviewErrorSnapshotStale);
  assert.equal(localizedReviewError({ code: "review_snapshot_stale" }, en), en.reviewErrorSnapshotStale);
});
