import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  agentNotificationPermission,
  requestAgentNotificationPermission,
  showAgentAttentionNotification,
} from "./agentAttentionDelivery";

class TestNotification extends EventTarget {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async () => TestNotification.permission);
  readonly close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
  }
}

beforeEach(() => {
  TestNotification.permission = "default";
  TestNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("window", { isSecureContext: true, focus: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("agent attention system notifications", () => {
  it("does not request permission or send alerts during normal delivery", () => {
    expect(
      showAgentAttentionNotification({
        title: "Input needed",
        body: "Thread",
        tag: "one",
        onClick: vi.fn(),
      }),
    ).toBeNull();
    expect(TestNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("reports unsupported contexts and respects denied permission", async () => {
    vi.stubGlobal("window", { isSecureContext: false });
    expect(agentNotificationPermission()).toBe("unsupported");
    expect(await requestAgentNotificationPermission()).toBe(false);
    vi.stubGlobal("window", { isSecureContext: true });
    TestNotification.permission = "denied";
    expect(await requestAgentNotificationPermission()).toBe(false);
    expect(TestNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("requests permission from the explicit enable action", async () => {
    TestNotification.requestPermission.mockResolvedValueOnce("granted");
    expect(await requestAgentNotificationPermission()).toBe(true);
    expect(TestNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("reports failures delivered asynchronously by the notification platform", () => {
    TestNotification.permission = "granted";
    const onError = vi.fn();
    const notification = showAgentAttentionNotification({
      title: "Input needed",
      body: "Thread",
      tag: "one",
      onClick: vi.fn(),
      onError,
    });
    notification?.dispatchEvent(new Event("error"));
    expect(onError).toHaveBeenCalledOnce();
  });

  it("closes the alert, focuses the client, and opens its thread on click", () => {
    TestNotification.permission = "granted";
    const openThread = vi.fn();
    const notification = showAgentAttentionNotification({
      title: "Input needed",
      body: "Fix staging",
      tag: "env:thread",
      onClick: openThread,
    });
    expect(notification).toBeInstanceOf(TestNotification);
    // The mock exposes the browser click event without launching an OS alert.
    const delivered = notification as unknown as TestNotification;
    expect(delivered.options).toEqual({ body: "Fix staging", tag: "env:thread", silent: true });
    delivered.dispatchEvent(new Event("click"));
    expect(delivered.close).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(openThread).toHaveBeenCalledOnce();
  });
});
