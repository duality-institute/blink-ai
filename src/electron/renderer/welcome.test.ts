import { describe, expect, it } from "bun:test";
import { bridge, openWelcome } from "./welcome-test-harness";

const SCREEN = "#steps li:nth-child(1) .step-action";
const MICROPHONE = "#steps li:nth-child(2) .step-action";

describe("welcome panel", () => {
  it("only displays existing grants after Check access is clicked", async () => {
    const { browser, page } = await openWelcome({
      states: { screen: "granted", microphone: "denied" },
    });
    try {
      expect(await page.locator(SCREEN).textContent()).toBe("Allow screen recording");
      await page.locator("#check").click();
      expect(await page.locator(SCREEN).textContent()).toBe("✓All set");
      expect(await page.locator(SCREEN).isDisabled()).toBe(true);
      expect(await page.locator(MICROPHONE).textContent()).toBe("Allow microphone");
      expect(await page.locator("#status").textContent()).toBe("Blink needs two macOS permissions before it can capture anything.");
      expect((await bridge(page)).requests).toEqual([]);
      expect(await page.locator("#check").textContent()).toBe("Not all granted — check again");
    } finally { await browser.close(); }
  });

  it("requests access without updating the row until an explicit check", async () => {
    const { browser, page } = await openWelcome({
      states: { screen: "denied", microphone: "denied" },
      grants: ["screen"],
    });
    try {
      await page.locator(SCREEN).click();
      expect(await page.locator(SCREEN).textContent()).toBe("Allow screen recording");
      expect(await page.locator(SCREEN).isEnabled()).toBe(true);
      await page.locator("#check").click();
      expect(await page.locator(SCREEN).textContent()).toBe("✓All set");
      expect(await page.locator(SCREEN).isDisabled()).toBe(true);
      expect((await bridge(page)).requests).toEqual(["screen"]);
    } finally { await browser.close(); }
  });

  it("shows a pass when Check access observes both grants made in Settings", async () => {
    const { browser, page } = await openWelcome({
      states: { screen: "denied", microphone: "denied" },
    });
    try {
      await page.locator("#check").click();
      expect(await page.locator("#status").textContent()).toBe("Blink needs two macOS permissions before it can capture anything.");
      expect(await page.locator(SCREEN).isEnabled()).toBe(true);

      await page.evaluate(() => {
        const test = (window as unknown as {
          __welcomeTest: { states: { screen: string; microphone: string } };
        }).__welcomeTest;
        test.states = { screen: "granted", microphone: "granted" };
      });
      expect(await page.locator(SCREEN).textContent()).toBe("Allow screen recording");
      await page.locator("#check").click();

      expect(await page.locator(SCREEN).textContent()).toBe("✓All set");
      expect(await page.locator(MICROPHONE).textContent()).toBe("✓All set");
      expect(await page.locator("#status").textContent()).toBe("You're all set.");
      expect(await page.locator("#check").textContent()).toBe("✓ All set");
      expect((await bridge(page)).requests).toEqual([]);
    } finally { await browser.close(); }
  });

  it("dismisses with Not now and restarts with Restart Blink", async () => {
    const { browser, page } = await openWelcome();
    try {
      expect(await page.locator("#restart").isEnabled()).toBe(true);
      await page.locator("#later").click();
      expect((await bridge(page)).dismissals).toBe(1);

      await page.locator("#restart").click();
      expect((await bridge(page)).restarts).toBe(1);
    } finally { await browser.close(); }
  });
});
