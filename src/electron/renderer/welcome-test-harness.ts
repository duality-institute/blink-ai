import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { WelcomeAPI } from "../ipc";
import type { PermissionKind, PermissionStates } from "../welcome-steps";

type BridgeState = {
  states: PermissionStates;
  grants: PermissionKind[];
  requests: PermissionKind[];
  restarts: number;
  dismissals: number;
};

type HarnessWindow = Window & {
  welcome: WelcomeAPI;
  __welcomeTest: BridgeState;
};

async function welcomeBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "welcome.ts")],
    target: "browser",
  });
  if (!result.success) {
    throw new Error(`welcome bundle failed: ${JSON.stringify(result.logs)}`);
  }
  const output = result.outputs[0];
  if (output === undefined) throw new Error("welcome bundle produced no output");
  return output.text();
}

function welcomeHtml(): string {
  const css = readFileSync(resolve(import.meta.dir, "welcome.css"), "utf8");
  return readFileSync(resolve(import.meta.dir, "welcome.html"), "utf8")
    .replace(/\s*<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "")
    .replace(/\s*<script type="module" src="welcome\.js"><\/script>/, "")
    .replace("</head>", `<style>${css}</style></head>`);
}

export type WelcomeHarness = {
  readonly browser: Browser;
  readonly page: Page;
};

/** `grants` are the kinds macOS will report as granted once the row is clicked. */
export async function openWelcome(options?: {
  readonly states?: PermissionStates;
  readonly grants?: readonly PermissionKind[];
}): Promise<WelcomeHarness> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 560, height: 560 } });
  await page.setContent(welcomeHtml());
  await page.evaluate(
    (setup) => {
      const target = window as unknown as HarnessWindow;
      target.__welcomeTest = {
        states: setup.states,
        grants: [...setup.grants],
        requests: [],
        restarts: 0,
        dismissals: 0,
      };
      const test = target.__welcomeTest;
      target.welcome = {
        load: async () => test.states,
        request: async (kind) => {
          test.requests.push(kind);
          if (test.grants.includes(kind)) {
            test.states = { ...test.states, [kind]: "granted" };
          }
          return test.states;
        },
        restart: () => {
          test.restarts += 1;
        },
        dismiss: () => {
          test.dismissals += 1;
        },
      };
    },
    {
      states: options?.states ?? { screen: "denied", microphone: "not-determined" },
      grants: options?.grants ?? [],
    },
  );
  await page.addScriptTag({ content: await welcomeBundle(), type: "module" });
  await page.waitForTimeout(25);
  return { browser, page };
}

export function bridge(page: Page): Promise<BridgeState> {
  return page.evaluate(() => (window as unknown as HarnessWindow).__welcomeTest);
}
