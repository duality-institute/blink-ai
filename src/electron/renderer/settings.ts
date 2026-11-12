import type {
  AnswerLogEntry,
  SettingsAPI,
  SettingsTab,
  TranscriptSessionEntry,
} from "../ipc";
import { renderMarkdown } from "./markdown";

declare global {
  interface Window {
    settings: SettingsAPI;
  }
}

const RECENT_LIMIT = 20;
type PromptKind = "monitor" | "meeting";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
}

const tabButtons: Record<SettingsTab, HTMLButtonElement> = {
  prompts: element<HTMLButtonElement>("tab-prompts"),
  answers: element<HTMLButtonElement>("tab-answers"),
  transcripts: element<HTMLButtonElement>("tab-transcripts"),
};
const panels: Record<SettingsTab, HTMLElement> = {
  prompts: element("panel-prompts"),
  answers: element("panel-answers"),
  transcripts: element("panel-transcripts"),
};

const promptBoxes: Record<PromptKind, HTMLTextAreaElement> = {
  monitor: element<HTMLTextAreaElement>("monitor-prompt"),
  meeting: element<HTMLTextAreaElement>("meeting-prompt"),
};
const modeButtons: Record<PromptKind, { default: HTMLButtonElement; custom: HTMLButtonElement }> = {
  monitor: {
    default: element<HTMLButtonElement>("monitor-default"),
    custom: element<HTMLButtonElement>("monitor-custom"),
  },
  meeting: {
    default: element<HTMLButtonElement>("meeting-default"),
    custom: element<HTMLButtonElement>("meeting-custom"),
  },
};
const saveButton = element<HTMLButtonElement>("save");
const savedNote = element("saved");

const search = element<HTMLInputElement>("search");
const dayFilter = element<HTMLSelectElement>("day");
const sourceFilter = element<HTMLSelectElement>("source");
const answerList = element<HTMLUListElement>("answers");
const countLabel = element("count");
const emptyNote = element("empty");

const defaults: Record<PromptKind, string> = { monitor: "", meeting: "" };
const customText: Record<PromptKind, string> = { monitor: "", meeting: "" };
const useCustom: Record<PromptKind, boolean> = { monitor: false, meeting: false };

let answers: readonly AnswerLogEntry[] = [];
let answersLoaded = false;

const txSearch = element<HTMLInputElement>("tx-search");
const txDayFilter = element<HTMLSelectElement>("tx-day");
const txList = element<HTMLUListElement>("tx-list");
const txView = element("tx-view");
const txCount = element("tx-count");
const txEmpty = element("tx-empty");

let sessions: readonly TranscriptSessionEntry[] = [];
let transcriptsLoaded = false;
let selectedFile: string | null = null;
let searchTimer: number | null = null;

function showTab(tab: SettingsTab): void {
  for (const name of ["prompts", "answers", "transcripts"] as const) {
    const active = name === tab;
    tabButtons[name].setAttribute("aria-selected", String(active));
    panels[name].hidden = !active;
  }
  if (tab === "answers" && !answersLoaded) void loadAnswers();
  if (tab === "transcripts" && !transcriptsLoaded) void loadTranscripts();
}

function applyMode(kind: PromptKind): void {
  const custom = useCustom[kind];
  const box = promptBoxes[kind];
  box.value = custom ? customText[kind] : defaults[kind];
  box.readOnly = !custom;
  box.classList.toggle("is-readonly", !custom);
  modeButtons[kind].default.classList.toggle("is-active", !custom);
  modeButtons[kind].default.setAttribute("aria-checked", String(!custom));
  modeButtons[kind].custom.classList.toggle("is-active", custom);
  modeButtons[kind].custom.setAttribute("aria-checked", String(custom));
}

function setMode(kind: PromptKind, custom: boolean): void {
  if (useCustom[kind] === custom) return;
  if (useCustom[kind]) customText[kind] = promptBoxes[kind].value;
  useCustom[kind] = custom;
  if (custom && customText[kind].trim() === "") customText[kind] = defaults[kind];
  applyMode(kind);
  if (custom) promptBoxes[kind].focus();
}

async function loadPrompts(): Promise<void> {
  const payload = await window.settings.loadPrompts();
  defaults.monitor = payload.monitorDefault;
  defaults.meeting = payload.meetingDefault;
  customText.monitor = payload.monitorPrompt;
  customText.meeting = payload.meetingPrompt;
  useCustom.monitor = payload.monitorPrompt.trim() !== "";
  useCustom.meeting = payload.meetingPrompt.trim() !== "";
  applyMode("monitor");
  applyMode("meeting");
}

async function savePrompts(): Promise<void> {
  for (const kind of ["monitor", "meeting"] as const) {
    if (useCustom[kind]) customText[kind] = promptBoxes[kind].value;
  }
  saveButton.disabled = true;
  await window.settings.savePrompts({
    monitorPrompt: useCustom.monitor ? customText.monitor.trim() : "",
    meetingPrompt: useCustom.meeting ? customText.meeting.trim() : "",
  });
  saveButton.disabled = false;
  savedNote.hidden = false;
  window.setTimeout(() => {
    savedNote.hidden = true;
  }, 1600);
}

function dayKey(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayLabel(key: string): string {
  const parts = key.split("-").map(Number);
  const [year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) return key;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatWhen(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function highlight(root: HTMLElement, query: string): void {
  if (query === "") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.textContent;
    if (text !== null && text.toLowerCase().includes(query)) targets.push(node);
  }
  for (const node of targets) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let index = lower.indexOf(query);
    while (index !== -1) {
      fragment.append(text.slice(cursor, index));
      const hit = document.createElement("mark");
      hit.textContent = text.slice(index, index + query.length);
      fragment.append(hit);
      cursor = index + query.length;
      index = lower.indexOf(query, cursor);
    }
    fragment.append(text.slice(cursor));
    node.replaceWith(fragment);
  }
}

function renderAnswer(entry: AnswerLogEntry, query: string): HTMLLIElement {
  const item = document.createElement("li");
  const meta = document.createElement("div");
  meta.className = "meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = entry.source;
  const when = document.createElement("span");
  when.textContent = formatWhen(entry.timestamp);
  const took = document.createElement("span");
  took.textContent = `${(entry.durationMs / 1000).toFixed(1)}s`;
  meta.append(badge, when, took);

  const body = document.createElement("div");
  body.className = "answer-body";
  body.innerHTML = renderMarkdown(entry.answer);
  highlight(body, query);

  item.append(meta, body);
  return item;
}

function refreshDayOptions(): void {
  const seen = new Set<string>();
  for (const entry of answers) {
    const key = dayKey(entry.timestamp);
    if (key !== "") seen.add(key);
  }
  const days = [...seen].sort().reverse();
  const previous = dayFilter.value;
  dayFilter.replaceChildren();
  const recent = document.createElement("option");
  recent.value = "recent";
  recent.textContent = `Latest ${RECENT_LIMIT}`;
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All dates";
  dayFilter.append(recent, all);
  for (const key of days) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = dayLabel(key);
    dayFilter.append(option);
  }
  dayFilter.value = [...dayFilter.options].some((option) => option.value === previous)
    ? previous
    : "recent";
}

function renderAnswers(): void {
  const query = search.value.trim().toLowerCase();
  const source = sourceFilter.value;
  const day = dayFilter.value;

  let matches = answers.filter((entry) => {
    if (source !== "all" && entry.source !== source) return false;
    if (day !== "recent" && day !== "all" && dayKey(entry.timestamp) !== day) return false;
    return query === "" || entry.answer.toLowerCase().includes(query);
  });
  if (day === "recent" && query === "") matches = matches.slice(0, RECENT_LIMIT);

  answerList.replaceChildren(...matches.map((entry) => renderAnswer(entry, query)));
  emptyNote.hidden = matches.length > 0;
  emptyNote.textContent = answers.length === 0 ? "No answers yet." : "No answers match.";
  countLabel.textContent =
    matches.length === answers.length
      ? `${answers.length} answer${answers.length === 1 ? "" : "s"}`
      : `${matches.length} of ${answers.length}`;
}

async function loadAnswers(): Promise<void> {
  answers = await window.settings.loadAnswers();
  answersLoaded = true;
  refreshDayOptions();
  renderAnswers();
}

function formatSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sessionLabel(entry: TranscriptSessionEntry): string {
  return `${dayLabel(entry.day)} · ${entry.startedAt.slice(0, 5)}`;
}

function renderSessionList(): void {
  const day = txDayFilter.value;
  const visible =
    day === "all" ? sessions : sessions.filter((entry) => entry.day === day);

  txList.replaceChildren(
    ...visible.map((entry) => {
      const item = document.createElement("li");
      item.className = "tx-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(entry.file === selectedFile));
      item.classList.toggle("is-active", entry.file === selectedFile);

      const title = document.createElement("span");
      title.className = "tx-item-title";
      title.textContent = sessionLabel(entry);

      const meta = document.createElement("span");
      meta.className = "tx-item-meta";
      meta.textContent =
        entry.matchCount > 0
          ? `${entry.matchCount} match${entry.matchCount === 1 ? "" : "es"}`
          : `${entry.lineCount} lines · ${formatSize(entry.byteSize)}`;

      item.append(title, meta);
      item.addEventListener("click", () => void selectSession(entry.file));
      return item;
    }),
  );

  txEmpty.hidden = visible.length > 0;
  txEmpty.textContent =
    txSearch.value.trim() === ""
      ? "No meeting transcripts yet."
      : "No transcript matches.";
  txCount.textContent =
    visible.length === 0
      ? ""
      : `${visible.length} session${visible.length === 1 ? "" : "s"}`;
  if (visible.length === 0) txView.replaceChildren();
}

function refreshTranscriptDays(): void {
  const days = [...new Set(sessions.map((entry) => entry.day))].sort().reverse();
  const previous = txDayFilter.value;
  txDayFilter.replaceChildren();
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All dates";
  txDayFilter.append(all);
  for (const day of days) {
    const option = document.createElement("option");
    option.value = day;
    option.textContent = dayLabel(day);
    txDayFilter.append(option);
  }
  txDayFilter.value = days.includes(previous) ? previous : "all";
}

async function selectSession(file: string): Promise<void> {
  selectedFile = file;
  const markdown = await window.settings.readTranscript(file);
  txView.innerHTML = renderMarkdown(markdown);
  highlight(txView, txSearch.value.trim().toLowerCase());
  txView.scrollTop = 0;
  renderSessionList();
}

async function loadTranscripts(): Promise<void> {
  sessions = await window.settings.loadTranscripts(txSearch.value.trim());
  transcriptsLoaded = true;
  refreshTranscriptDays();
  const stillVisible = sessions.some((entry) => entry.file === selectedFile);
  if (!stillVisible) selectedFile = null;
  renderSessionList();
  const first = sessions[0];
  if (selectedFile === null && first !== undefined) {
    await selectSession(first.file);
  } else if (selectedFile !== null) {
    await selectSession(selectedFile);
  }
}

tabButtons.prompts.addEventListener("click", () => showTab("prompts"));
tabButtons.answers.addEventListener("click", () => showTab("answers"));
tabButtons.transcripts.addEventListener("click", () => showTab("transcripts"));
txSearch.addEventListener("input", () => {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadTranscripts(), 180);
});
txDayFilter.addEventListener("change", renderSessionList);
for (const kind of ["monitor", "meeting"] as const) {
  modeButtons[kind].default.addEventListener("click", () => setMode(kind, false));
  modeButtons[kind].custom.addEventListener("click", () => setMode(kind, true));
}
saveButton.addEventListener("click", () => void savePrompts());
search.addEventListener("input", renderAnswers);
dayFilter.addEventListener("change", renderAnswers);
sourceFilter.addEventListener("change", renderAnswers);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.settings.dismiss();
});

window.settings.onShowTab(showTab);
void loadPrompts();
