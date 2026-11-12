import { contextBridge, ipcRenderer } from "electron";
import type { BlinkAPI, PresenterAPI, SettingsAPI, WelcomeAPI } from "./ipc";
import {
  CHANNEL_ABORT,
  CHANNEL_DISMISS,
  CHANNEL_POPUP_LOAD_HEADER,
  CHANNEL_POPUP_HEADER_CHANGED,
  CHANNEL_POPUP_SET_PRIVACY,
  CHANNEL_POPUP_PRIVACY_CHANGED,
  CHANNEL_POPUP_SET_MODE,
  CHANNEL_POPUP_MEETING_CHANGED,
  CHANNEL_POPUP_ASK_MEETING,
  CHANNEL_POPUP_SET_DRAFT,
  CHANNEL_POPUP_MONITORING_CHANGED,
  CHANNEL_TRANSCRIPT_UPDATE,
  CHANNEL_ANSWER_START,
  CHANNEL_ANSWER_DELTA,
  CHANNEL_ANSWER_DONE,
  CHANNEL_ANSWER_ERROR,
  CHANNEL_PRESENTER_LOAD,
  CHANNEL_PRESENTER_SAVE,
  CHANNEL_PRESENTER_DISMISS,
  CHANNEL_PRESENTER_SET_PRIVACY,
  CHANNEL_PRESENTER_PRIVACY_CHANGED,
  CHANNEL_PRESENTER_SCROLL,
  CHANNEL_SETTINGS_LOAD_PROMPTS,
  CHANNEL_SETTINGS_SAVE_PROMPTS,
  CHANNEL_SETTINGS_LOAD_ANSWERS,
  CHANNEL_SETTINGS_DISMISS,
  CHANNEL_SETTINGS_LOAD_TRANSCRIPTS,
  CHANNEL_SETTINGS_READ_TRANSCRIPT,
  CHANNEL_SETTINGS_SHOW_TAB,
  CHANNEL_WELCOME_LOAD,
  CHANNEL_WELCOME_REQUEST,
  CHANNEL_WELCOME_RESTART,
  CHANNEL_WELCOME_DISMISS,
} from "./ipc";

function subscribe<T>(channel: string, callback: (payload: T) => void): void {
  ipcRenderer.on(channel, (_event, payload: T) => callback(payload));
}

const blinkAPI: BlinkAPI = {
  loadHeader() {
    return ipcRenderer.invoke(CHANNEL_POPUP_LOAD_HEADER);
  },
  onHeaderChanged(callback): void {
    subscribe(CHANNEL_POPUP_HEADER_CHANGED, callback);
  },
  onAnswerStart(callback): void {
    subscribe(CHANNEL_ANSWER_START, callback);
  },
  onAnswerDelta(callback): void {
    subscribe(CHANNEL_ANSWER_DELTA, callback);
  },
  onAnswerDone(callback): void {
    subscribe(CHANNEL_ANSWER_DONE, callback);
  },
  onAnswerError(callback): void {
    subscribe(CHANNEL_ANSWER_ERROR, callback);
  },
  abort(): void {
    ipcRenderer.send(CHANNEL_ABORT);
  },
  dismiss(): void {
    ipcRenderer.send(CHANNEL_DISMISS);
  },
  setPrivacy(hidden): void {
    ipcRenderer.send(CHANNEL_POPUP_SET_PRIVACY, hidden);
  },
  onPrivacyChanged(callback): void {
    subscribe(CHANNEL_POPUP_PRIVACY_CHANGED, callback);
  },
  setMode(mode): void {
    ipcRenderer.send(CHANNEL_POPUP_SET_MODE, mode);
  },
  askMeeting(): void {
    ipcRenderer.send(CHANNEL_POPUP_ASK_MEETING);
  },
  setDraft(text): void {
    ipcRenderer.send(CHANNEL_POPUP_SET_DRAFT, text);
  },
  onMeetingChanged(callback): void {
    subscribe(CHANNEL_POPUP_MEETING_CHANGED, callback);
  },
  onMonitoringChanged(callback): void {
    subscribe(CHANNEL_POPUP_MONITORING_CHANGED, callback);
  },
  onTranscriptUpdate(callback): void {
    subscribe(CHANNEL_TRANSCRIPT_UPDATE, callback);
  },
};

const presenterAPI: PresenterAPI = {
  load() {
    return ipcRenderer.invoke(CHANNEL_PRESENTER_LOAD);
  },
  save(markdown) {
    return ipcRenderer.invoke(CHANNEL_PRESENTER_SAVE, markdown);
  },
  dismiss(): void {
    ipcRenderer.send(CHANNEL_PRESENTER_DISMISS);
  },
  setPrivacy(hidden): void {
    ipcRenderer.send(CHANNEL_PRESENTER_SET_PRIVACY, hidden);
  },
  onPrivacyChanged(callback): void {
    subscribe(CHANNEL_PRESENTER_PRIVACY_CHANGED, callback);
  },
  onScroll(callback): void {
    subscribe(CHANNEL_PRESENTER_SCROLL, callback);
  },
};

const settingsAPI: SettingsAPI = {
  loadPrompts() {
    return ipcRenderer.invoke(CHANNEL_SETTINGS_LOAD_PROMPTS);
  },
  savePrompts(prompts) {
    return ipcRenderer.invoke(CHANNEL_SETTINGS_SAVE_PROMPTS, prompts);
  },
  loadAnswers() {
    return ipcRenderer.invoke(CHANNEL_SETTINGS_LOAD_ANSWERS);
  },
  loadTranscripts(query) {
    return ipcRenderer.invoke(CHANNEL_SETTINGS_LOAD_TRANSCRIPTS, query);
  },
  readTranscript(file) {
    return ipcRenderer.invoke(CHANNEL_SETTINGS_READ_TRANSCRIPT, file);
  },
  dismiss(): void {
    ipcRenderer.send(CHANNEL_SETTINGS_DISMISS);
  },
  onShowTab(callback): void {
    subscribe(CHANNEL_SETTINGS_SHOW_TAB, callback);
  },
};

const welcomeAPI: WelcomeAPI = {
  load() {
    return ipcRenderer.invoke(CHANNEL_WELCOME_LOAD);
  },
  request(kind) {
    return ipcRenderer.invoke(CHANNEL_WELCOME_REQUEST, kind);
  },
  restart(): void {
    ipcRenderer.send(CHANNEL_WELCOME_RESTART);
  },
  dismiss(): void {
    ipcRenderer.send(CHANNEL_WELCOME_DISMISS);
  },
};

contextBridge.exposeInMainWorld("blink", blinkAPI);
contextBridge.exposeInMainWorld("presenter", presenterAPI);
contextBridge.exposeInMainWorld("settings", settingsAPI);
contextBridge.exposeInMainWorld("welcome", welcomeAPI);
