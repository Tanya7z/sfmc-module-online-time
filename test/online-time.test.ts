import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dateKey, formatDuration, monthKey, startOfLocalDay } from "../sapi/src/timeutil.ts";

describe("online-time timeutil", () => {
  it("Asia/Shanghai 日期键", () => {
    // 2026-09-03 23:30 UTC = 2026-09-04 07:30 +8
    const ms = Date.UTC(2026, 8, 3, 23, 30, 0);
    assert.equal(dateKey(ms, "Asia/Shanghai"), "2026-09-04");
    assert.equal(monthKey(ms, "Asia/Shanghai"), "2026-09");
  });

  it("startOfLocalDay 对齐本地午夜", () => {
    const ms = Date.UTC(2026, 8, 4, 10, 0, 0);
    const start = startOfLocalDay(ms, "Asia/Shanghai");
    assert.equal(dateKey(start, "Asia/Shanghai"), "2026-09-04");
    assert.equal(dateKey(start - 1, "Asia/Shanghai"), "2026-09-03");
  });

  it("formatDuration", () => {
    assert.equal(formatDuration(65), "1分5秒");
    assert.equal(formatDuration(3600), "1时");
  });
});
