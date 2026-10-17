import { EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { clearSourceCooldown: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.clear }));

import { SourceClearCooldown } from "./SourceClearCooldown";

const environmentId = EnvironmentId.make("remote");
const input = { sourceId: UsageLimitSourceId.make("hub"), accountId: "claude.json" };
let root: Root;
let container: HTMLDivElement;
const button = () => container.querySelector("button")!;
const status = () => container.querySelector('[role="status"]')?.textContent;
async function renderControl() {
  await act(() => root.render(<SourceClearCooldown environmentId={environmentId} input={input} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.clear.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("prevents duplicate clears while pending and reports success without a credit confirmation", async () => {
  let complete!: () => void;
  const pending = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
    complete = () => resolve({ _tag: "Success", value: undefined });
  });
  state.clear.mockReturnValue(pending);
  await renderControl();
  await act(() => {
    button().click();
    button().click();
  });
  expect(button().disabled).toBe(true);
  expect(button().textContent).toBe("Clearing…");
  expect(state.clear).toHaveBeenCalledExactlyOnceWith({ environmentId, input });
  await act(async () => {
    complete();
  });
  expect(button().disabled).toBe(false);
  expect(status()).toBe("Proxy cooldown cleared. Retry your request.");
});

it("shows the hub's failure and allows a fresh retry", async () => {
  state.clear
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: { error: new Error("The hub could not be reached.") },
    })
    .mockResolvedValueOnce({ _tag: "Success", value: undefined });
  await renderControl();
  await act(async () => {
    button().click();
  });
  expect(status()).toBe("The hub could not be reached.");
  expect(button().disabled).toBe(false);
  await act(async () => {
    button().click();
  });
  expect(status()).toBe("Proxy cooldown cleared. Retry your request.");
});
