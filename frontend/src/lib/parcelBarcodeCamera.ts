type DetectedBarcode = { rawValue: string };

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};

type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

/** Match the decoder crop to the object-cover camera frame shown to the operator. */
export function drawScanRegion(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!videoWidth || !videoHeight) return false;
  const frameAspectRatio = video.clientWidth > 0 && video.clientHeight > 0
    ? video.clientWidth / video.clientHeight : 3;
  const videoAspectRatio = videoWidth / videoHeight;
  const sourceWidth = Math.round(videoAspectRatio > frameAspectRatio ? videoHeight * frameAspectRatio : videoWidth);
  const sourceHeight = Math.round(videoAspectRatio > frameAspectRatio ? videoHeight : videoWidth / frameAspectRatio);
  const sourceX = Math.round((videoWidth - sourceWidth) / 2);
  const sourceY = Math.round((videoHeight - sourceHeight) / 2);
  const outputWidth = Math.min(960, sourceWidth);
  const outputHeight = Math.max(1, Math.round((outputWidth * sourceHeight) / sourceWidth));
  if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
    canvas.width = outputWidth;
    canvas.height = outputHeight;
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return false;
  context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
  return true;
}

export async function createNativeBarcodeDetector() {
  const detectorConstructor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (!detectorConstructor) return null;
  try {
    const supported = (await detectorConstructor.getSupportedFormats?.()) ?? [];
    if (!supported.includes("code_128")) return null;
    return new detectorConstructor({ formats: ["code_128"] });
  } catch {
    return null;
  }
}
