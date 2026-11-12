import { assertImageUploadLimits, STAGING_OVERHEAD_BYTES } from "./upload-limits";

export type MeetingContextSummary = {
  readonly screenshotCount: number;
  readonly screenshotBytes: number;
};

/**
 * Holds the screenshots staged for the next Meeting ask.
 *
 * Transcript text is not stored here: it is assembled from the session history
 * at ask time so each ask carries only the speech the model has not seen.
 */
export class MeetingContextBuffer {
  private readonly screenshotPaths = new Map<string, number>();

  stageScreenshot(screenshotPath: string, bytes = 0, contextBytes = 0): boolean {
    if (this.screenshotPaths.has(screenshotPath)) return false;
    this.assertCanStage(bytes, contextBytes);
    this.screenshotPaths.set(screenshotPath, bytes);
    return true;
  }

  assertCanStage(bytes: number, contextBytes = 0): void {
    assertImageUploadLimits([...this.screenshotPaths.values(), bytes], contextBytes + STAGING_OVERHEAD_BYTES);
  }

  assertWithinLimits(contextBytes = 0): void {
    assertImageUploadLimits([...this.screenshotPaths.values()], contextBytes + STAGING_OVERHEAD_BYTES);
  }

  staged(): readonly string[] {
    return [...this.screenshotPaths.keys()];
  }

  summary(): MeetingContextSummary {
    return {
      screenshotCount: this.screenshotPaths.size,
      screenshotBytes: [...this.screenshotPaths.values()].reduce((total, bytes) => total + bytes, 0),
    };
  }

  removeScreenshots(submittedPaths: readonly string[]): void {
    for (const screenshotPath of submittedPaths) this.screenshotPaths.delete(screenshotPath);
  }

  clear(): readonly string[] {
    const screenshotPaths = [...this.screenshotPaths.keys()];
    this.screenshotPaths.clear();
    return screenshotPaths;
  }
}
