import { EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { clearSourceCooldown: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.clear }));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { SourceClearCooldown } from "./SourceClearCooldown";

const environmentId = EnvironmentId.make("remote");
const input = { sourceId: UsageLimitSourceId.make("hub"), accountId: "claude.json" };
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.clear.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("prevents duplicate clears while pending and reports success without a credit confirmation", async () => {
  let complete!: () => void;
  const pending = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
    complete = () => resolve({ _tag: "Success", value: undefined });
  });
  state.clear.mockReturnValue(pending);
  await act(() => {
    renderer = create(<SourceClearCooldown environmentId={environmentId} input={input} />);
  });
  const button = () => renderer.root.findByType("button");
  await act(() => {
    button().props.onClick();
    button().props.onClick();
  });
  expect(button().props.disabled).toBe(true);
  expect(button().children).toEqual(["Clearing…"]);
  expect(state.clear).toHaveBeenCalledExactlyOnceWith({ environmentId, input });
  await act(async () => {
    complete();
  });
  expect(button().props.disabled).toBe(false);
  expect(renderer.root.findByProps({ role: "status" }).children).toEqual([
    "Proxy cooldown cleared. Retry your request.",
  ]);
});

it("shows the hub's failure and allows a fresh retry", async () => {
  state.clear
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: { error: new Error("The hub could not be reached.") },
    })
    .mockResolvedValueOnce({ _tag: "Success", value: undefined });
  await act(() => {
    renderer = create(<SourceClearCooldown environmentId={environmentId} input={input} />);
  });
  await act(async () => {
    renderer.root.findByType("button").props.onClick();
  });
  expect(renderer.root.findByProps({ role: "status" }).children).toEqual([
    "The hub could not be reached.",
  ]);
  expect(renderer.root.findByType("button").props.disabled).toBe(false);
  await act(async () => {
    renderer.root.findByType("button").props.onClick();
  });
  expect(renderer.root.findByProps({ role: "status" }).children).toEqual([
    "Proxy cooldown cleared. Retry your request.",
  ]);
});
