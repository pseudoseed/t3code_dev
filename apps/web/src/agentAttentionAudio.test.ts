import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const platform = vi.hoisted(() => ({ isElectron: true }));
vi.mock("./env", () => platform);

class TestAudioContext {
  static instances: TestAudioContext[] = [];
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  readonly starts: number[] = [];
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });

  constructor() {
    TestAudioContext.instances.push(this);
  }

  createOscillator() {
    return {
      frequency: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      start: (time: number) => this.starts.push(time),
      stop: vi.fn(),
    };
  }

  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
}

beforeEach(() => {
  vi.resetModules();
  platform.isElectron = true;
  TestAudioContext.instances = [];
  vi.stubGlobal("AudioContext", TestAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent attention audio", () => {
  it("sounds the first desktop request without a prior click or test sound", async () => {
    const { playAgentAttentionSound } = await import("./agentAttentionDelivery");
    await playAgentAttentionSound();
    expect(TestAudioContext.instances).toHaveLength(1);
    const context = TestAudioContext.instances[0]!;
    expect(context.state).toBe("running");
    expect(context.starts).toHaveLength(2);
  });

  it("resumes suspended desktop audio for a later request", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { playAgentAttentionSound } = await import("./agentAttentionDelivery");
    await playAgentAttentionSound();
    const context = TestAudioContext.instances[0]!;
    context.state = "suspended";
    now.mockReturnValue(2_000);
    await playAgentAttentionSound();
    expect(TestAudioContext.instances).toHaveLength(1);
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(context.starts).toHaveLength(4);
  });

  it("coalesces simultaneous desktop requests into one chime", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { playAgentAttentionSound } = await import("./agentAttentionDelivery");
    await Promise.all([playAgentAttentionSound(), playAgentAttentionSound()]);
    expect(TestAudioContext.instances).toHaveLength(1);
    expect(TestAudioContext.instances[0]!.starts).toHaveLength(2);
  });

  it("keeps browser audio inactive until a user gesture unlocks it", async () => {
    platform.isElectron = false;
    const { playAgentAttentionSound, unlockAgentAttentionAudio } =
      await import("./agentAttentionDelivery");
    await expect(playAgentAttentionSound()).rejects.toThrow("Click in the app");
    expect(TestAudioContext.instances).toHaveLength(0);
    await unlockAgentAttentionAudio();
    await playAgentAttentionSound();
    expect(TestAudioContext.instances[0]!.starts).toHaveLength(2);
  });
});
