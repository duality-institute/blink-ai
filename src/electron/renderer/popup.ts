import type {
  AnswerStartPayload,
  AnswerDonePayload,
  BlinkAPI,
  BlinkMode,
  PopupHeaderPayload,
  PopupMonitoringPayload,
  PopupMeetingPayload,
  TranscriptLine,
  TranscriptUpdatePayload,
} from "../ipc";
import type { AnswerDelta, AnswerError } from "../../core/types";
import { meetingTimeLeft } from "../../core/session-policy";
import { renderMarkdown } from "./markdown";

declare global {
  interface Window {
    blink?: BlinkAPI;
  }
}

type PopupState = "idle" | "answering" | "streaming" | "done" | "error";

const state = {
  streamBuffer: "",
  currentState: "idle" as PopupState,
  meeting: false,
  meetingStarting: false,
  meetingAsking: false,
  monitoring: false,
  monitoringStarting: false,
  screenshotCount: 0,
  screenshotBytes: 0,
  imageContextBusy: false,
  meetingStartedAt: null as number | null,
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`popup: missing #${id} in DOM`);
  }
  return node as T;
}

const dom = {
  root: el<HTMLElement>("root"),
  source: el<HTMLElement>("source"),
  modeControl: el<HTMLElement>("mode-control"),
  mode: el<HTMLSelectElement>("mode"),
  modeLabel: el<HTMLElement>("mode-label"),
  meetingBudget: el<HTMLElement>("meeting-budget"),
  meetingBudgetText: el<HTMLElement>("meeting-budget-text"),
  meetingContext: el<HTMLElement>("meeting-context"),
  contextCopy: el<HTMLElement>("context-copy"),
  askMeeting: el<HTMLButtonElement>("ask-meeting"),
  messageInput: el<HTMLTextAreaElement>("message-input"),
  transcriptPanel: el<HTMLElement>("transcript-panel"),
  transcriptScroll: el<HTMLElement>("transcript-scroll"),
  transcriptLines: el<HTMLElement>("transcript-lines"),
  transcriptVolatile: el<HTMLElement>("transcript-volatile"),
  transcriptCount: el<HTMLElement>("transcript-count"),
  privacy: el<HTMLButtonElement>("privacy"),
  privacyLabel: el<HTMLElement>("privacy-label"),
  reconciledPill: el<HTMLElement>("reconciled-pill"),
  stoppedPill: el<HTMLElement>("stopped-pill"),
  sessionNote: el<HTMLElement>("session-note"),
  abort: el<HTMLButtonElement>("abort"),
  close: el<HTMLButtonElement>("close"),
  answering: el<HTMLElement>("answering"),
  answer: el<HTMLElement>("answer"),
  error: el<HTMLElement>("error"),
  errorMessage: el<HTMLElement>("error-message"),
  runtimeError: el<HTMLElement>("runtime-error"),
  runtimeErrorText: el<HTMLElement>("runtime-error-text"),
  runtimeErrorClose: el<HTMLButtonElement>("runtime-error-close"),
  body: el<HTMLElement>("body"),
};

function setState(next: PopupState): void {
  dom.root.classList.remove(
    "state-idle",
    "state-answering",
    "state-streaming",
    "state-done",
    "state-error",
  );
  dom.root.classList.add(`state-${next}`);
  state.currentState = next;

  // Visibility for the always-in-DOM slots.
  dom.answering.hidden = next !== "answering";
  dom.error.hidden = next !== "error";
  const running = next === "answering" || next === "streaming";
  dom.abort.hidden = !running;
  dom.root.setAttribute("aria-busy", running ? "true" : "false");
  if (!running) {
    dom.abort.disabled = false;
    dom.abort.textContent = "Stop";
  }
  renderMeetingContext();
}

function renderSource(payload: AnswerStartPayload): void {
  const detected = new Date(payload.detectedAt);
  const timeStr = Number.isNaN(detected.getTime())
    ? payload.detectedAt
    : detected.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

  // textContent is XSS-safe; filename comes from the OS but treat as untrusted.
  const label = document.createElement("span");
  label.className = "source-label";
  label.textContent = payload.title;
  label.title = payload.title;
  const time = document.createElement("span");
  time.className = "source-time";
  time.textContent = timeStr;
  dom.source.replaceChildren(label, time);
  dom.source.dataset.source = payload.source;
}

function updatePrivacy(hidden: boolean): void {
  dom.privacy.setAttribute("aria-checked", hidden ? "true" : "false");
  dom.privacyLabel.textContent = hidden ? "Private" : "Visible";
  dom.privacy.classList.toggle("is-private", hidden);
  dom.privacy.title = hidden
    ? "Private: Blink windows are hidden from screen capture. Click to reveal them."
    : "Visible: Blink windows appear in screen capture. Click to hide them.";
}

function renderMode(): void {
  const starting = state.meetingStarting || state.monitoringStarting;
  const mode = state.meeting || state.meetingStarting
    ? "meeting"
    : state.monitoring || state.monitoringStarting
      ? "monitor"
      : "off";
  if (dom.mode.value !== mode) dom.mode.value = mode;
  dom.mode.disabled = starting;
  dom.modeControl.classList.toggle("is-monitor", mode === "monitor");
  dom.modeControl.classList.toggle("is-meeting", mode === "meeting");
  dom.modeControl.classList.toggle("is-starting", starting);
  dom.modeControl.setAttribute("aria-busy", starting ? "true" : "false");
  dom.modeLabel.textContent = modeLabel(mode, starting);
  renderMeetingBudget();
}

function modeLabel(mode: BlinkMode, starting: boolean): string {
  if (starting) return "Starting…";
  if (mode === "monitor") return "Monitor";
  if (mode !== "meeting") return "Off";
  return state.meetingStartedAt === null
    ? "Meeting"
    : `Meeting · ${elapsedLabel(state.meetingStartedAt)}`;
}

function updateMonitoring(payload: PopupMonitoringPayload): void {
  state.monitoring = payload.monitoring;
  state.monitoringStarting = payload.monitoringStarting;
  renderMode();
  renderMeetingContext();
}

const transcriptRows = new Map<string, HTMLElement>();

function renderTranscript(): void {
  const visible = state.meeting;
  dom.transcriptPanel.hidden = !visible;
  dom.root.classList.toggle("has-transcript", visible);
  updateTranscriptPlaceholder();
}

/** textContent only: transcript text is captured speech, never trusted as markup. */
function buildTranscriptRow(line: TranscriptLine): HTMLElement {
  const row = document.createElement("div");
  row.className = "transcript-line";
  const speaker = document.createElement("span");
  speaker.className = `transcript-speaker is-${line.speaker}`;
  speaker.textContent = line.speaker === "them" ? "Them" : "You";
  const text = document.createElement("span");
  text.className = "transcript-text";
  text.textContent = line.text;
  row.append(speaker, text);
  return row;
}

function setRowText(row: HTMLElement, text: string): void {
  const node = row.querySelector(".transcript-text");
  if (node !== null) node.textContent = text;
}

function updateTranscriptPlaceholder(): void {
  const empty =
    transcriptRows.size === 0 && dom.transcriptVolatile.childElementCount === 0;
  dom.transcriptLines.classList.toggle("is-empty", empty);
  dom.transcriptCount.textContent =
    transcriptRows.size === 0 ? "" : String(transcriptRows.size);
}

/**
 * Only follows new speech when the user is already reading the newest lines.
 * Scrolling back through an hour of transcript would otherwise be yanked to the
 * bottom every 150ms.
 */
function isTranscriptAtBottom(): boolean {
  const node = dom.transcriptScroll;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
}

function pinTranscriptToBottom(): void {
  dom.transcriptScroll.scrollTop = dom.transcriptScroll.scrollHeight;
}

function onTranscriptUpdate(payload: TranscriptUpdatePayload): void {
  if (payload.reset === true) {
    transcriptRows.clear();
    dom.transcriptLines.replaceChildren();
    dom.transcriptVolatile.replaceChildren();
  }

  const follow = isTranscriptAtBottom();

  for (const line of payload.changed ?? []) {
    const existing = transcriptRows.get(line.id);
    if (existing !== undefined) {
      setRowText(existing, line.text);
      continue;
    }
    const row = buildTranscriptRow(line);
    transcriptRows.set(line.id, row);
    dom.transcriptLines.append(row);
  }

  dom.transcriptVolatile.replaceChildren(
    ...(payload.volatile ?? []).map((line) => {
      const row = buildTranscriptRow(line);
      row.classList.add("is-partial");
      return row;
    }),
  );

  updateTranscriptPlaceholder();
  if (follow) pinTranscriptToBottom();
}

function clearMeetingAnswer(): void {
  const label = document.createElement("span");
  label.className = "source-label";
  label.textContent = "Ready for a message or screenshot";
  dom.source.replaceChildren(label);
  delete dom.source.dataset["source"];
  dom.answer.replaceChildren();
  dom.errorMessage.textContent = "";
  state.streamBuffer = "";
  setReconciled(false);
  setStopped(false);
  setState("idle");
}

function updateMeeting(payload: PopupMeetingPayload): void {
  const wasMeeting = state.meeting;
  const hadScreenshots = state.screenshotCount > 0;
  state.meeting = payload.meeting;
  state.meetingStarting = payload.meetingStarting;
  state.meetingAsking = payload.asking;
  state.screenshotCount = Math.max(0, Math.floor(payload.screenshotCount));
  state.screenshotBytes = payload.screenshotBytes ?? 0;
  state.imageContextBusy = payload.imageContextBusy ?? false;
  renderTranscript();
  state.meetingStartedAt = payload.startedAt ?? null;
  renderMode();
  renderMeetingContext();
  if (hadScreenshots && state.screenshotCount === 0 && !state.meetingAsking && state.currentState === "error") {
    dom.errorMessage.textContent = "";
    setState("idle");
  }
  if (wasMeeting && !payload.meeting) clearMeetingAnswer();
}

function elapsedLabel(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

function renderMeetingBudget(): void {
  const startedAt = state.meetingStartedAt;
  if (!state.meeting || startedAt === null) {
    dom.meetingBudget.hidden = true;
    return;
  }
  const { remainingMs, warning } = meetingTimeLeft(startedAt, Date.now());
  dom.meetingBudget.hidden = !warning;
  if (!warning) return;
  const total = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  dom.meetingBudgetText.textContent = `Meeting closing soon — stops in ${minutes}:${String(seconds).padStart(2, "0")} at the 3 hour limit.`;
}

window.setInterval(renderMode, 1_000);

function renderMeetingContext(): void {
  const visible =
    state.meeting ||
    state.meetingStarting ||
    state.monitoring ||
    state.monitoringStarting;
  const answerRunning =
    state.currentState === "answering" || state.currentState === "streaming";
  dom.meetingContext.hidden = !visible;
  dom.root.classList.toggle("has-meeting", visible);

  const staged = state.screenshotCount;
  dom.contextCopy.textContent = state.meetingStarting
    ? "Preparing private context…"
    : staged > 0
      ? `${staged} screenshot${staged === 1 ? "" : "s"} staged`
      : state.meeting
        ? "Transcript only"
        : "No screenshots yet";
  dom.contextCopy.classList.toggle("has-context", staged > 0);
  const askable = state.meeting || (state.monitoring && (staged > 0 || dom.messageInput.value.trim() !== ""));
  dom.askMeeting.disabled =
    !askable || state.monitoringStarting || state.meetingStarting || state.meetingAsking || state.imageContextBusy || answerRunning;
  dom.askMeeting.textContent = state.meetingAsking ? "Asking…" : "Ask";
  dom.askMeeting.setAttribute(
    "aria-busy",
    state.meetingAsking ? "true" : "false",
  );
}

function updateRuntimeError(header: PopupHeaderPayload): void {
  const message = header.lastError;
  if (message === undefined || message === "") {
    dom.runtimeError.hidden = true;
    dom.runtimeErrorText.textContent = "";
    return;
  }
  dom.runtimeErrorText.textContent = message;
  dom.runtimeError.hidden = false;
}

function applyHeader(header: PopupHeaderPayload): void {
  updatePrivacy(header.hideFromCapture);
  updateMonitoring(header);
  updateMeeting(header);
  updateRuntimeError(header);
}

async function loadHeader(): Promise<void> {
  if (window.blink === undefined) return;
  try {
    const header = await window.blink.loadHeader();
    if (!draftEdited) dom.messageInput.value = header.draftText ?? "";
    applyHeader(header);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const label = dom.source.querySelector<HTMLElement>(".source-label");
    if (label !== null) {
      label.textContent = "Configuration unavailable";
      label.title = message;
    }
  }
}

function renderStream(): void {
  dom.answer.innerHTML = renderMarkdown(state.streamBuffer);
}

// Track whether the user has scrolled up mid-stream; if so, don't auto-scroll.
let userScrolled = false;
dom.body.addEventListener("scroll", () => {
  const atBottom =
    dom.body.scrollHeight - dom.body.scrollTop - dom.body.clientHeight < 8;
  userScrolled = !atBottom;
});

function maybeScrollToBottom(): void {
  if (userScrolled) return;
  dom.body.scrollTop = dom.body.scrollHeight;
}

function setReconciled(reconciled: boolean): void {
  dom.reconciledPill.hidden = !reconciled;
  dom.reconciledPill.setAttribute(
    "aria-hidden",
    reconciled ? "false" : "true",
  );
}

function setStopped(stopped: boolean): void {
  dom.stoppedPill.hidden = !stopped;
  dom.stoppedPill.setAttribute("aria-hidden", stopped ? "false" : "true");
}

function setSessionRenewed(renewed: boolean): void {
  dom.sessionNote.hidden = !renewed;
}

function onStart(payload: AnswerStartPayload): void {
  state.streamBuffer = "";
  userScrolled = false;
  dom.answer.innerHTML = "";
  dom.errorMessage.textContent = "";
  dom.abort.disabled = false;
  dom.abort.textContent = "Stop";
  setReconciled(false);
  setStopped(false);
  setSessionRenewed(false);
  renderSource(payload);
  setState("answering");
}

function onDelta(payload: AnswerDelta): void {
  if (typeof payload.text !== "string" || payload.text.length === 0) return;
  state.streamBuffer += payload.text;
  if (state.currentState !== "streaming") {
    setState("streaming");
  }
  renderStream();
  maybeScrollToBottom();
}

function onDone(payload: AnswerDonePayload): void {
  // Prefer the authoritative `text` from the completion payload — it may have
  // been reconciled from /message after an SSE drop and differ from the sum
  // of deltas received live.
  if (typeof payload.text === "string" && payload.text.length > 0) {
    state.streamBuffer = payload.text;
    renderStream();
  } else if (payload.cancelled === true && state.streamBuffer.length === 0) {
    state.streamBuffer = "Stopped before an answer was returned.";
    renderStream();
  }
  setReconciled(payload.reconciled === true && payload.cancelled !== true);
  setStopped(payload.cancelled === true);
  setSessionRenewed(payload.sessionRenewed === true);
  if (!payload.cancelled && payload.submittedText === dom.messageInput.value) {
    dom.messageInput.value = "";
    window.blink?.setDraft("");
  }
  setState("done");
  maybeScrollToBottom();
}

function onError(payload: AnswerError): void {
  const msg =
    typeof payload.message === "string" && payload.message.length > 0
      ? payload.message
      : "unknown error";
  // textContent is XSS-safe.
  dom.errorMessage.textContent = msg;
  setStopped(false);
  setSessionRenewed(false);
  setState("error");
}

function dismiss(): void {
  if (window.blink !== undefined) {
    window.blink.dismiss();
  }
}

dom.close.addEventListener("click", () => {
  dismiss();
});

dom.privacy.addEventListener("click", () => {
  const hidden = dom.privacy.getAttribute("aria-checked") !== "true";
  updatePrivacy(hidden);
  window.blink?.setPrivacy(hidden);
});

dom.mode.addEventListener("change", () => {
  const mode = dom.mode.value;
  if (mode !== "off" && mode !== "monitor" && mode !== "meeting") return;
  state.monitoring = mode === "monitor";
  state.monitoringStarting = mode === "monitor";
  state.meeting = false;
  state.meetingStarting = mode === "meeting";
  state.meetingStartedAt = null;
  renderMode();
  renderTranscript();
  renderMeetingContext();
  window.blink?.setMode(mode);
});

let draftEdited = false;
dom.messageInput.addEventListener("input", () => {
  draftEdited = true;
  window.blink?.setDraft(dom.messageInput.value);
  renderMeetingContext();
});

dom.askMeeting.addEventListener("click", () => {
  if (window.blink === undefined || dom.askMeeting.disabled) return;
  state.meetingAsking = true;
  renderMeetingContext();
  window.blink.setDraft(dom.messageInput.value);
  window.blink.askMeeting();
});

window.addEventListener("resize", () => {
  if (dom.transcriptPanel.hidden) return;
  requestAnimationFrame(() => {
    if (!dom.transcriptPanel.hidden) pinTranscriptToBottom();
  });
});

dom.runtimeErrorClose.addEventListener("click", () => {
  dom.runtimeError.hidden = true;
});

dom.abort.addEventListener("click", () => {
  if (window.blink === undefined || dom.abort.disabled) return;
  dom.abort.disabled = true;
  dom.abort.textContent = "Stopping…";
  window.blink.abort();
});

function bootstrap(): void {
  if (window.blink === undefined) {
    const banner = document.createElement("div");
    banner.className = "bridge-error";
    banner.textContent =
      "blink: preload bridge not loaded (window.blink === undefined). Popup is dead.";
    document.body.appendChild(banner);
    return;
  }

  window.blink.onAnswerStart(onStart);
  window.blink.onHeaderChanged(applyHeader);
  window.blink.onAnswerDelta(onDelta);
  window.blink.onAnswerDone(onDone);
  window.blink.onAnswerError(onError);
  window.blink.onPrivacyChanged(updatePrivacy);
  window.blink.onMonitoringChanged(updateMonitoring);
  window.blink.onMeetingChanged(updateMeeting);
  window.blink.onTranscriptUpdate(onTranscriptUpdate);
  void loadHeader();
}

bootstrap();
