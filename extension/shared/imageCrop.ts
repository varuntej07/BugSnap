import type { CropRect, ViewportSize } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load screenshot image."));
    image.src = dataUrl;
  });
}

export async function getImageDimensions(dataUrl: string): Promise<ViewportSize> {
  const image = await loadImage(dataUrl);
  return {
    width: image.naturalWidth,
    height: image.naturalHeight
  };
}

export function scaleRectToImage(rect: CropRect, viewport: ViewportSize, imageSize: ViewportSize): CropRect {
  const xScale = imageSize.width / viewport.width;
  const yScale = imageSize.height / viewport.height;

  return {
    x: Math.round(rect.x * xScale),
    y: Math.round(rect.y * yScale),
    width: Math.round(rect.width * xScale),
    height: Math.round(rect.height * yScale)
  };
}

function sanitizeRect(rect: CropRect, imageSize: ViewportSize): CropRect {
  const safeX = clamp(Math.round(rect.x), 0, imageSize.width - 1);
  const safeY = clamp(Math.round(rect.y), 0, imageSize.height - 1);
  const safeWidth = clamp(Math.round(rect.width), 1, imageSize.width - safeX);
  const safeHeight = clamp(Math.round(rect.height), 1, imageSize.height - safeY);

  return {
    x: safeX,
    y: safeY,
    width: safeWidth,
    height: safeHeight
  };
}

export async function cropBase64ToPngBlob(dataUrl: string, rect: CropRect): Promise<Blob> {
  const image = await loadImage(dataUrl);
  const imageSize = { width: image.naturalWidth, height: image.naturalHeight };
  const safeRect = sanitizeRect(rect, imageSize);

  const canvas = document.createElement("canvas");
  canvas.width = safeRect.width;
  canvas.height = safeRect.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  context.drawImage(
    image,
    safeRect.x,
    safeRect.y,
    safeRect.width,
    safeRect.height,
    0,
    0,
    safeRect.width,
    safeRect.height
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Failed to export cropped image."));
    }, "image/png");
  });
}
