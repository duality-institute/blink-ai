import { execFile } from "node:child_process";
import { app, systemPreferences } from "electron";
import { resolveAudioHelperPath } from "./meeting-listener";
import {
  PERMISSION_KINDS,
  type PermissionKind,
  type PermissionState,
  type PermissionStates,
} from "./welcome-steps";

export function permissionState(kind: PermissionKind): PermissionState {
  const status = systemPreferences.getMediaAccessStatus(kind);
  if (status === "granted") return "granted";
  return status === "not-determined" ? "not-determined" : "denied";
}

export function permissionStates(): PermissionStates {
  return Object.fromEntries(
    PERMISSION_KINDS.map((kind) => [kind, permissionState(kind)]),
  ) as unknown as PermissionStates;
}

/**
 * Electron can neither request screen recording nor see a grant made after
 * launch: a running process keeps the answer it started with. The helper is a
 * new process under Blink's identity, so it can ask macOS and read the
 * current answer.
 */
function screenHelper(flag: "--screen-access" | "--request-screen-access"): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      resolveAudioHelperPath(app.getAppPath()),
      [flag],
      { timeout: 10_000 },
      (error, stdout) => resolve(error === null && stdout.trim() === "true"),
    );
  });
}

const freshScreenGranted = (): Promise<boolean> => screenHelper("--screen-access");

export async function currentPermissionStates(): Promise<PermissionStates> {
  const states = permissionStates();
  if (states.screen === "granted" || !(await freshScreenGranted())) return states;
  return { ...states, screen: "granted" };
}

export async function requestPermission(kind: PermissionKind): Promise<void> {
  if (kind === "microphone") {
    if (permissionState("microphone") !== "granted") {
      await systemPreferences.askForMediaAccess("microphone");
    }
    return;
  }
  if ((await currentPermissionStates()).screen !== "granted") {
    await screenHelper("--request-screen-access");
  }
}
