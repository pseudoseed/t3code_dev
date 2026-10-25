import { describe, expect, it } from "@effect/vitest";

import { formatConnectionDiagnostics } from "./diagnostics";

describe("formatConnectionDiagnostics", () => {
  it("renders one line per entry with an ISO timestamp", () => {
    expect(
      formatConnectionDiagnostics([
        { at: Date.UTC(2026, 8, 12, 17, 26, 0), kind: "app-state", detail: "active" },
        { at: Date.UTC(2026, 8, 12, 17, 26, 1), kind: "network", detail: "offline type=NONE" },
      ]),
    ).toBe(
      "2026-09-12T17:26:00.000Z app-state active\n2026-09-12T17:26:01.000Z network offline type=NONE",
    );
  });
});
