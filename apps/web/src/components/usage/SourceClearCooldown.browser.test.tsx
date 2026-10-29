import { EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { clearSourceCooldown: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.clear }));

import { SourceClearCooldown } from "./SourceClearCooldown";

const environmentId = EnvironmentId.make("remote");
const input = { sourceId: UsageLimitSourceId.make("hub"), accountId: "claude.json" };
const button = (screen: Screen) => screen.container.querySelector("button")!;
const status = (screen: Screen) => screen.container.querySelector('[role="status"]')?.textContent;
function setup() {
  state.clear.mockReset();
}
const control = () => <SourceClearCooldown environmentId={environmentId} input={input} />;

it("prevents duplicate clears while pending and reports success without a credit confirmation", async () => {
  setup();
  let complete!: () => void;
  const pending = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
    complete = () => resolve({ _tag: "Success", value: undefined });
  });
  state.clear.mockReturnValue(pending);
  await using screen = await render(control());
  await act(() => {
    button(screen).click();
    button(screen).click();
  });
  expect(button(screen).disabled).toBe(true);
  expect(button(screen).textContent).toBe("Clearing…");
  expect(state.clear).toHaveBeenCalledExactlyOnceWith({ environmentId, input });
  await act(async () => {
    complete();
  });
  expect(button(screen).disabled).toBe(false);
  expect(status(screen)).toBe("Proxy cooldown cleared. Retry your request.");
});

it("shows the hub's failure and allows a fresh retry", async () => {
  setup();
  state.clear
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: { error: new Error("The hub could not be reached.") },
    })
    .mockResolvedValueOnce({ _tag: "Success", value: undefined });
  await using screen = await render(control());
  await act(async () => {
    button(screen).click();
  });
  expect(status(screen)).toBe("The hub could not be reached.");
  expect(button(screen).disabled).toBe(false);
  await act(async () => {
    button(screen).click();
  });
  expect(status(screen)).toBe("Proxy cooldown cleared. Retry your request.");
});
