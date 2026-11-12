import { describe, expect, it } from "bun:test";
import {
  allGranted,
  INTRO_MESSAGE,
  PERMISSION_KINDS,
  WELCOME_STEPS,
  type PermissionStates,
} from "./welcome-steps";

const states = (screen: string, microphone: string): PermissionStates =>
  ({ screen, microphone }) as PermissionStates;

describe("welcome steps", () => {
  it("covers every permission kind exactly once, screen first", () => {
    expect(WELCOME_STEPS.map((step) => step.kind)).toEqual([...PERMISSION_KINDS]);
    expect(WELCOME_STEPS).toHaveLength(new Set(WELCOME_STEPS.map((s) => s.kind)).size);
  });

  it("gates the restart on every permission being granted", () => {
    expect(allGranted(states("granted", "granted"))).toBe(true);
    expect(allGranted(states("granted", "not-determined"))).toBe(false);
    expect(allGranted(states("denied", "granted"))).toBe(false);
  });

  it("has one intro line that names both permissions", () => {
    expect(INTRO_MESSAGE).toContain("two macOS permissions");
  });
});
