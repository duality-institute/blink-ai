export const MAX_SCREENSHOTS_PER_ASK = 10;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ASK_BODY_BYTES = 20 * 1024 * 1024;
export const STAGING_OVERHEAD_BYTES = 64 * 1024;

export const mib = (bytes: number): number => bytes / (1024 * 1024);

export class UploadLimitError extends Error {
  override readonly name = "UploadLimitError";
}

export function assertImageUploadLimits(sizes: readonly number[], contextBytes = 0): void {
  if (sizes.length > MAX_SCREENSHOTS_PER_ASK) {
    throw new UploadLimitError(
      `Maximum ${MAX_SCREENSHOTS_PER_ASK} screenshots per Ask. Clear images to start again.`,
    );
  }
  if (sizes.some((size) => size > MAX_IMAGE_BYTES)) {
    throw new UploadLimitError(
      `Screenshot exceeds ${mib(MAX_IMAGE_BYTES)} MiB. Capture a smaller region.`,
    );
  }
  if (sizes.reduce((total, size) => total + size, contextBytes) > MAX_ASK_BODY_BYTES) {
    throw new UploadLimitError(
      `Context exceeds ${mib(MAX_ASK_BODY_BYTES)} MiB. Clear images or capture a smaller region.`,
    );
  }
}
