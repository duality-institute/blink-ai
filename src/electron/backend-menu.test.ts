import { describe, expect, it } from "bun:test";
import { BACKEND_LABELS, BLINK_BACKENDS, type BlinkBackend } from "../core/types";
import { backendMenu } from "./backend-menu";

describe("tray backend menu", () => {
  it("offers every local backend as a radio choice with only the configured one checked", () => {
    const menu = backendMenu("codex", () => undefined);

    expect(menu.label).toBe(`Backend: ${BACKEND_LABELS.codex}`);
    expect(menu.submenu.map(({ label, type, checked }) => ({ label, type, checked }))).toEqual(
      BLINK_BACKENDS.map((backend) => ({
        label: BACKEND_LABELS[backend],
        type: "radio",
        checked: backend === "codex",
      })),
    );
  });

  it("reports the backend picked from the menu", () => {
    const picked: BlinkBackend[] = [];
    const menu = backendMenu("opencode", (backend) => picked.push(backend));

    menu.submenu.find((choice) => choice.label === BACKEND_LABELS.claude)?.click();

    expect(picked).toEqual(["claude"]);
  });
});
