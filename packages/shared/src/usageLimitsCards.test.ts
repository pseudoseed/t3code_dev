import { describe, expect, it } from "vite-plus/test";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import { DIAL, dialRing, dialSafeBoxSize, limitSeverity, splitDialWindows } from "./usageLimits.ts";

function window(
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent = 0,
): ServerProviderUsageWindow {
  return { id, kind, label: id, usedPercent };
}

describe("limitSeverity", () => {
  it("stays quiet until a window is worth planning around", () => {
    expect(limitSeverity(0)).toBe("good");
    expect(limitSeverity(59.9)).toBe("good");
    expect(limitSeverity(60)).toBe("warn");
    expect(limitSeverity(84.9)).toBe("warn");
    expect(limitSeverity(85)).toBe("critical");
    expect(limitSeverity(100)).toBe("critical");
  });
});

describe("splitDialWindows", () => {
  it("puts the session on the inner ring and the weekly on the outer one", () => {
    const weekly = window("weekly", "weekly");
    const session = window("session", "session");
    const other = window("other", "other");
    expect(splitDialWindows([weekly, session, other])).toEqual({
      current: session,
      overall: weekly,
      // The outer window stays in the list so its exact percent and reset are
      // still readable next to the arc.
      rest: [weekly, other],
    });
  });

  it("falls back to the first window for the dial and the next for the ring", () => {
    const monthly = window("monthly", "monthly");
    const other = window("other", "other");
    expect(splitDialWindows([other, monthly])).toEqual({
      current: other,
      overall: monthly,
      rest: [monthly],
    });
  });

  it("draws one ring when the account reports a single window", () => {
    const session = window("session", "session");
    expect(splitDialWindows([session])).toEqual({ current: session, overall: null, rest: [] });
  });

  it("has nothing to draw when the account reports no windows", () => {
    expect(splitDialWindows([])).toEqual({ current: null, overall: null, rest: [] });
  });
});

describe("dialRing", () => {
  it("spans the used share of the circle from twelve o'clock", () => {
    const { circumference, dash, rotation } = dialRing(25, 10);
    expect(circumference).toBeCloseTo(2 * Math.PI * 10);
    expect(dash).toBeCloseTo(circumference / 4);
    expect(rotation).toBe(-90);
  });

  it("draws nothing at zero and a full circle at a hundred", () => {
    expect(dialRing(0, 10).dash).toBe(0);
    expect(dialRing(100, 10).dash).toBeCloseTo(2 * Math.PI * 10);
  });

  it("keeps a tiny non-zero share visible instead of collapsing it", () => {
    // A 0.2% weekly is still information; a sub-pixel dash would erase it.
    expect(dialRing(0.2, 10).dash).toBe(1.5);
  });

  it("clamps a percent the provider reported outside the scale", () => {
    expect(dialRing(140, 10).dash).toBeCloseTo(2 * Math.PI * 10);
    expect(dialRing(-5, 10).dash).toBe(0);
  });
});

describe("dial geometry", () => {
  it("keeps the outer stroke inside the viewBox", () => {
    // Half the stroke sits outside the radius; past the half-box it is clipped.
    expect(DIAL.outer.radius + DIAL.outer.width / 2).toBeLessThanOrEqual(DIAL.size / 2);
  });

  it("keeps the inner ring clear of the outer one", () => {
    const innerOuterEdge = DIAL.inner.radius + DIAL.inner.width / 2;
    const outerInnerEdge = DIAL.outer.radius - DIAL.outer.width / 2;
    expect(innerOuterEdge).toBeLessThan(outerInnerEdge);
  });

  it("reports a text box that fits inside the inner ring at every corner", () => {
    const safe = dialSafeBoxSize();
    // A corner of the box is the furthest point from the centre; if that is
    // inside the ring's clear radius, no line of text can reach the stroke.
    const cornerDistance = Math.hypot(safe / 2, safe / 2);
    expect(cornerDistance).toBeLessThanOrEqual(DIAL.inner.radius - DIAL.inner.width / 2);
  });

  it("is narrower than the ring it sits in, not as wide as the diameter", () => {
    // The bug this guards: sizing the reading against the diameter lets a line
    // sitting away from the centre cross the stroke.
    expect(dialSafeBoxSize()).toBeLessThan((DIAL.inner.radius - DIAL.inner.width / 2) * 2);
  });
});
