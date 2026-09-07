import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  accessibilityLabel: (value: unknown) => value,
  background: (value: unknown) => value,
  cornerRadius: (value: unknown) => value,
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  frame: (value: unknown) => value,
  layoutPriority: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
  resizable: (value: unknown) => value,
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import {
  AgentActivity,
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "./AgentActivity";

function makeRow(overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "gpt-5.4",
    phase: "running",
    status: "Working",
    updatedAt: "2026-05-25T13:07:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

const props = {
  title: "PseudoCode",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T13:07:00.000Z",
  activities: [],
} satisfies AgentActivityProps;

const environment = {
  colorScheme: "dark",
  isLuminanceReduced: false,
} as const;

describe("AgentActivity content and navigation", () => {
  it("prioritizes a request over running work and links to the request", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ threadTitle: "Working thread" }),
          makeRow({
            threadId: "input",
            threadTitle: "Release approval",
            phase: "waiting_for_approval",
            deepLink: "/threads/env-1/input",
          }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner.indexOf("Release approval")).toBeLessThan(banner.indexOf("Working thread"));
    expect(banner).toContain("t3code://threads/env-1/input");
    expect(JSON.stringify(layout.compactTrailing)).toContain("Approve");
  });

  it("shows a failure reason with its thread instead of a generic agent failure", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 0,
        activities: [
          makeRow({
            phase: "failed",
            threadTitle: "Deploy staging",
            detail: "Deployment credential expired",
          }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Deploy staging");
    expect(banner).toContain("Deployment credential expired");
    expect(banner).toContain("Needs review");
    expect(banner).not.toContain("0 active");
  });

  it("bounds the banner to two task rows and explains additional active work", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 6,
        activities: [1, 2, 3, 4, 5, 6].map((n) =>
          makeRow({ threadId: `t${n}`, threadTitle: `Thread ${n}` }),
        ),
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Thread 1");
    expect(banner).toContain("Thread 2");
    expect(banner).not.toContain("Thread 3");
    expect(banner).toContain("more active in PseudoCode");
  });

  it("never places untrusted external URLs in a widget link", () => {
    const layout = AgentActivity(
      { ...props, activities: [makeRow({ deepLink: "//evil.example" })] },
      environment as never,
    );
    expect(JSON.stringify(layout)).not.toContain("widgetURL");
  });
});
