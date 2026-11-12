import { describe, expect, it } from "bun:test";
import { AppStateStore, type AppState } from "./app-state";

function initialState(): AppState {
  return {
    monitoring: false,
    monitoringStarting: false,
    meeting: false,
    meetingStarting: false,
    meetingAsking: false,
    meetingScreenshotCount: 0,
    showTranscript: true,
    hideFromCapture: true,
    backend: "opencode",
  };
}

describe("AppStateStore Meeting state", () => {
  it("starts off and applies Meeting lifecycle patches", () => {
    const store = new AppStateStore(initialState());

    expect(store.get()).toMatchObject({
      meeting: false,
      meetingStarting: false,
    });
    store.update({ meetingStarting: true });
    expect(store.get()).toMatchObject({
      meeting: false,
      meetingStarting: true,
    });
    store.update({
      meeting: true,
      meetingStarting: false,
      meetingAsking: true,
    });
    expect(store.get()).toMatchObject({
      meeting: true,
      meetingStarting: false,
      meetingAsking: true,
    });
  });

  it("tracks staged screenshot context", () => {
    const store = new AppStateStore(initialState());

    store.update({ meetingScreenshotCount: 2 });

    expect(store.get()).toMatchObject({ meetingScreenshotCount: 2 });
  });

  it("tracks the persisted transcript strip preference", () => {
    const store = new AppStateStore(initialState());

    store.update({ showTranscript: false });

    expect(store.get().showTranscript).toBe(false);
  });

  it("keeps the selected local backend through unrelated updates", () => {
    const store = new AppStateStore(initialState());

    store.update({ backend: "claude" });
    store.update({ meetingStarting: true, hideFromCapture: false });

    expect(store.get().backend).toBe("claude");
  });

  it("clears an error on its own so the tray stops showing the error icon", async () => {
    const store = new AppStateStore(initialState(), 20);

    store.update({ lastError: "boom" });
    expect(store.get().lastError).toBe("boom");

    await Bun.sleep(60);
    expect(store.get().lastError).toBeUndefined();
  });

  it("keeps the newest error visible for its full window", async () => {
    const store = new AppStateStore(initialState(), 60);

    store.update({ lastError: "first" });
    await Bun.sleep(30);
    store.update({ lastError: "second" });
    await Bun.sleep(40);

    expect(store.get().lastError).toBe("second");
    await Bun.sleep(40);
    expect(store.get().lastError).toBeUndefined();
  });
});
