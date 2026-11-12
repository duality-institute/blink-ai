import type { WelcomeAPI } from "../ipc";
import {
  allGranted,
  INTRO_MESSAGE,
  WELCOME_STEPS,
  type PermissionStates,
  type WelcomeStep,
} from "../welcome-steps";

declare global {
  interface Window {
    readonly welcome: WelcomeAPI;
  }
}

const stepList = document.getElementById("steps") as HTMLUListElement;
const statusLine = document.getElementById("status") as HTMLParagraphElement;
const checkAccess = document.getElementById("check") as HTMLButtonElement;
const restart = document.getElementById("restart") as HTMLButtonElement;
const later = document.getElementById("later") as HTMLButtonElement;

function buildStep(step: WelcomeStep): { item: HTMLLIElement; action: HTMLButtonElement } {
  const item = document.createElement("li");
  item.className = "step";

  const text = document.createElement("div");
  text.className = "step-text";
  const title = document.createElement("div");
  title.className = "step-title";
  title.textContent = step.title;
  const detail = document.createElement("div");
  detail.className = "step-detail";
  detail.textContent = step.detail;
  text.append(title, detail);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "step-action";

  item.append(text, action);
  return { item, action };
}

function renderAction(action: HTMLButtonElement, step: WelcomeStep, granted: boolean): void {
  action.replaceChildren();
  if (granted) {
    const check = document.createElement("span");
    check.className = "step-check";
    check.textContent = "✓";
    action.append(check);
  }
  action.append(document.createTextNode(granted ? step.granted : step.action));
  action.disabled = granted;
}

const rows = WELCOME_STEPS.map((step) => {
  const { item, action } = buildStep(step);
  renderAction(action, step, false);
  action.addEventListener("click", () => {
    action.disabled = true;
    checkAccess.disabled = true;
    window.welcome
      .request(step.kind)
      .catch((error: unknown) => {
        checkAccess.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        action.disabled = false;
        checkAccess.disabled = false;
      });
  });
  stepList.append(item);
  return { step, item, action };
});

function apply(states: PermissionStates): void {
  for (const { step, item, action } of rows) {
    const granted = states[step.kind] === "granted";
    item.classList.toggle("is-granted", granted);
    renderAction(action, step, granted);
  }
  const passed = allGranted(states);
  statusLine.textContent = passed ? "You're all set." : INTRO_MESSAGE;
  checkAccess.textContent = passed ? "✓ All set" : "Not all granted — check again";
  checkAccess.classList.toggle("is-passed", passed);
}

checkAccess.addEventListener("click", () => {
  checkAccess.disabled = true;
  checkAccess.textContent = "Checking…";
  window.welcome.load()
    .then(apply)
    .catch((error: unknown) => {
      checkAccess.textContent = error instanceof Error ? error.message : String(error);
    })
    .finally(() => { checkAccess.disabled = false; });
});

restart.addEventListener("click", () => {
  restart.disabled = true;
  window.welcome.restart();
});

later.addEventListener("click", () => window.welcome.dismiss());

statusLine.textContent = INTRO_MESSAGE;
