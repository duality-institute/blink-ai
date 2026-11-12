export const PERMISSION_KINDS = ["screen", "microphone"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export type PermissionState = "granted" | "denied" | "not-determined";

export type PermissionStates = Readonly<Record<PermissionKind, PermissionState>>;

export type WelcomeStep = {
  readonly kind: PermissionKind;
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly granted: string;
};

export const WELCOME_STEPS: readonly WelcomeStep[] = [
  {
    kind: "screen",
    title: "Screen & System Audio Recording",
    detail: "Lets Blink capture screenshots and hear the other side of a meeting.",
    action: "Allow screen recording",
    granted: "All set",
  },
  {
    kind: "microphone",
    title: "Microphone",
    detail: "Lets Blink transcribe your own voice during a Meeting.",
    action: "Allow microphone",
    granted: "All set",
  },
];

export function allGranted(states: PermissionStates): boolean {
  return PERMISSION_KINDS.every((kind) => states[kind] === "granted");
}

export const INTRO_MESSAGE = "Blink needs two macOS permissions before it can capture anything.";
