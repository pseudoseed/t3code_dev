import { describe, expect, it } from "vite-plus/test";

import { stalledMillis } from "./EventLoopStallMonitor.ts";

describe("stalledMillis", () => {
  it("is zero for a timer that fired on time or early", () => {
    expect(stalledMillis({ beforeMs: 0, afterMs: 1_000, intervalMs: 1_000 })).toBe(0);
    expect(stalledMillis({ beforeMs: 0, afterMs: 990, intervalMs: 1_000 })).toBe(0);
  });

  it("measures only the time past the requested interval", () => {
    expect(stalledMillis({ beforeMs: 5_000, afterMs: 46_000, intervalMs: 1_000 })).toBe(40_000);
  });
});
