import type { PresenterAPI, PresenterScrollDirection } from "../ipc";
import { renderMarkdown } from "./markdown";

declare global {
  interface Window {
    presenter?: PresenterAPI;
  }
}

type Mode = "edit" | "present";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`presenter: missing #${id}`);
  return node as T;
}

const dom = {
  app: element<HTMLElement>("app"),
  editorView: element<HTMLElement>("editor-view"),
  presentView: element<HTMLElement>("present-view"),
  editor: element<HTMLTextAreaElement>("editor"),
  preview: element<HTMLElement>("preview"),
  emptyStage: element<HTMLElement>("empty-stage"),
  modeToggle: element<HTMLButtonElement>("mode-toggle"),
  close: element<HTMLButtonElement>("close"),
  privacy: element<HTMLInputElement>("privacy"),
  privacyLabel: element<HTMLElement>("privacy-label"),
  saveStatus: element<HTMLElement>("save-status"),
  wordCount: element<HTMLElement>("word-count"),
};

let mode: Mode = "edit";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;

function updateWordCount(): void {
  const words = dom.editor.value.trim().match(/\S+/g)?.length ?? 0;
  dom.wordCount.textContent = `${words} ${words === 1 ? "word" : "words"}`;
}

function updatePrivacy(hidden: boolean): void {
  dom.privacy.checked = hidden;
  dom.privacyLabel.textContent = hidden ? "Private" : "Visible";
  dom.privacy.closest("label")?.classList.toggle("is-private", hidden);
}

function renderStage(): void {
  const markdown = dom.editor.value;
  const empty = markdown.trim().length === 0;
  dom.preview.hidden = empty;
  dom.emptyStage.hidden = !empty;
  dom.preview.innerHTML = empty ? "" : renderMarkdown(markdown);
}

function scrollActiveView(direction: PresenterScrollDirection): void {
  const target = mode === "present" ? dom.presentView : dom.editor;
  const distance = Math.max(72, Math.round(target.clientHeight * 0.32));
  target.scrollBy({
    top: direction === "down" ? distance : -distance,
    behavior: "smooth",
  });
}

async function saveNow(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (window.presenter === undefined) return;
  if (saving !== null) await saving;

  const markdown = dom.editor.value;
  dom.saveStatus.textContent = "Saving…";
  dom.saveStatus.classList.remove("is-error");
  saving = window.presenter
    .save(markdown)
    .then(() => {
      dom.saveStatus.textContent =
        dom.editor.value === markdown ? "Saved locally" : "Unsaved changes";
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      dom.saveStatus.textContent = `Save failed: ${message}`;
      dom.saveStatus.classList.add("is-error");
    })
    .finally(() => {
      saving = null;
    });
  await saving;
}

function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  dom.saveStatus.textContent = "Unsaved changes";
  dom.saveStatus.classList.remove("is-error");
  saveTimer = setTimeout(() => {
    void saveNow();
  }, 350);
}

async function setMode(next: Mode): Promise<void> {
  if (next === mode) return;
  if (next === "present") {
    await saveNow();
    renderStage();
  }

  mode = next;
  dom.app.dataset.mode = next;
  dom.editorView.hidden = next !== "edit";
  dom.presentView.hidden = next !== "present";
  dom.modeToggle.textContent = next === "edit" ? "Present" : "Edit";

  if (next === "edit") {
    requestAnimationFrame(() => dom.editor.focus());
  } else {
    dom.presentView.scrollTop = 0;
    requestAnimationFrame(() => dom.presentView.focus({ preventScroll: true }));
  }
}

async function dismiss(): Promise<void> {
  await saveNow();
  window.presenter?.dismiss();
}

dom.editor.addEventListener("input", () => {
  updateWordCount();
  scheduleSave();
});

dom.modeToggle.addEventListener("click", () => {
  void setMode(mode === "edit" ? "present" : "edit");
});

dom.close.addEventListener("click", () => {
  void dismiss();
});

dom.privacy.addEventListener("change", () => {
  updatePrivacy(dom.privacy.checked);
  window.presenter?.setPrivacy(dom.privacy.checked);
});

async function bootstrap(): Promise<void> {
  if (window.presenter === undefined) {
    dom.saveStatus.textContent = "Presenter bridge unavailable";
    dom.saveStatus.classList.add("is-error");
    return;
  }

  window.presenter.onPrivacyChanged(updatePrivacy);
  window.presenter.onScroll(scrollActiveView);
  try {
    const initial = await window.presenter.load();
    dom.editor.value = initial.markdown;
    updatePrivacy(initial.hideFromCapture);
    updateWordCount();
    dom.saveStatus.textContent = "Saved locally";
    dom.editor.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dom.saveStatus.textContent = `Load failed: ${message}`;
    dom.saveStatus.classList.add("is-error");
  }
}

void bootstrap();
