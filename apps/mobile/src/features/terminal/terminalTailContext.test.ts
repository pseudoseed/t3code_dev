import { COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS, ComposerContextId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTerminalTailContextRecord } from "./terminalTailContext";

const contextId = ComposerContextId.make("ctx-1");

function build(text: string, maxLines?: number) {
  return buildTerminalTailContextRecord({
    text,
    contextId,
    terminalId: "default",
    terminalLabel: "Terminal 1",
    ...(maxLines === undefined ? {} : { maxLines }),
  });
}

function numberedLines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

describe("buildTerminalTailContextRecord", () => {
  it("keeps the last 200 lines and numbers them from the top of the capture", () => {
    const record = build(numberedLines(300).join("\n"));
    expect(record).toMatchObject({
      kind: "terminal",
      label: "Terminal 1 · last 200 lines",
      lineStart: 101,
      lineEnd: 300,
    });
    expect(record?.text.split("\n")).toEqual(numberedLines(300).slice(100));
  });

  it("ignores blank rows below the output", () => {
    const record = build("$ ls\nREADME.md\n\n  \n\n", 200);
    expect(record).toMatchObject({ text: "$ ls\nREADME.md", lineStart: 1, lineEnd: 2 });
  });

  it("returns null when the capture is only blank rows", () => {
    expect(build("\n \n\n")).toBeNull();
  });

  it("drops older lines to fit the context limit", () => {
    const line = "x".repeat(10_000);
    const record = build(Array.from({ length: 10 }, () => line).join("\n"));
    expect(record?.text.length).toBeLessThanOrEqual(COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS);
    expect(record).toMatchObject({ label: "Terminal 1 · last 6 lines", lineStart: 5, lineEnd: 10 });
  });

  it("keeps the end of a single line that is over the limit", () => {
    const record = build(`old\n${"a".repeat(COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS)}end`);
    expect(record?.text.length).toBe(COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS);
    expect(record?.text.endsWith("end")).toBe(true);
    expect(record).toMatchObject({ label: "Terminal 1 · last 1 line", lineStart: 2, lineEnd: 2 });
  });
});
