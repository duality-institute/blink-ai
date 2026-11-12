import { describe, expect, it } from "bun:test";
import path from "node:path";
import { resolveAppBundlePath, resolveAudioHelperPath } from "./meeting-listener";

describe("meeting transcript runtime helpers", () => {
  it("resolves the app bundle that owns Blink's privacy identity", () => {
    expect(resolveAppBundlePath("/opt/blink")).toBe(
      path.join("/opt/blink", "vendor", "Blink.app"),
    );
  });

  it("nests the audio helper inside the app bundle so it inherits that identity", () => {
    expect(resolveAudioHelperPath("/opt/blink")).toBe(
      path.join(
        "/opt/blink",
        "vendor",
        "Blink.app",
        "Contents",
        "Helpers",
        "BlinkAudio",
      ),
    );
  });

  it("gives the helper no bundle of its own, so TCC cannot list it separately", () => {
    expect(resolveAudioHelperPath("/opt/blink")).not.toContain("BlinkAudio.app");
  });

  it("keeps the helper inside the signed bundle rather than beside it", () => {
    expect(resolveAudioHelperPath("/opt/blink")).toStartWith(
      resolveAppBundlePath("/opt/blink"),
    );
  });
});
