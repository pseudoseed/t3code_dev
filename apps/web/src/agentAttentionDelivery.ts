import { isElectron } from "./env";

let audioContext: AudioContext | null = null;
let lastSoundAt = -Infinity;

/** Browsers need a user gesture; Electron can activate audio when an alert arrives. */
export async function unlockAgentAttentionAudio(): Promise<AudioContext> {
  if (typeof AudioContext === "undefined") {
    throw new Error("This browser does not support notification sounds.");
  }
  if (audioContext === null || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }
  if (audioContext.state !== "running") await audioContext.resume();
  return audioContext;
}

export async function playAgentAttentionSound(preview = false): Promise<void> {
  const context = preview || isElectron ? await unlockAgentAttentionAudio() : audioContext;
  if (context?.state !== "running") {
    throw new Error("Click in the app to allow notification sounds.");
  }
  // Several environments can request attention together; one chime is enough.
  const now = performance.now();
  if (!preview && now - lastSoundAt < 1_000) return;
  lastSoundAt = now;
  for (const [offset, frequency] of [
    [0, 660],
    [0.16, 880],
  ] as const) {
    const start = context.currentTime + offset;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
    oscillator.start(start);
    oscillator.stop(start + 0.21);
  }
}

export function agentNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined" || (!window.isSecureContext && !isElectron)) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestAgentNotificationPermission(): Promise<boolean> {
  const permission = agentNotificationPermission();
  if (permission === "unsupported" || permission === "denied") return false;
  return permission === "granted" || (await Notification.requestPermission()) === "granted";
}

/** Electron supports the same renderer API, delivering through the OS. */
export function showAgentAttentionNotification(input: {
  title: string;
  body: string;
  tag: string;
  onClick: () => void;
  onError?: () => void;
}): Notification | null {
  if (agentNotificationPermission() !== "granted") return null;
  const notification = new Notification(input.title, {
    body: input.body,
    tag: input.tag,
    // The app's sound preference owns the chime, avoiding a second OS sound.
    silent: true,
  });
  notification.addEventListener("click", () => {
    notification.close();
    window.focus();
    input.onClick();
  });
  notification.addEventListener("error", () => input.onError?.(), { once: true });
  return notification;
}
