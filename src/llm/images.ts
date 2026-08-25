/**
 * Pasted-image handling for Ask: clipboard → the ImageContent shape pi-ai
 * sends to the model ({ type: "image", data: <raw base64>, mimeType }).
 *
 * Screenshots arrive at display resolution, which is far more pixels than
 * any model reads and a lot of base64 to carry through a transcript, so
 * anything oversized is scaled down and re-encoded here. Whether the
 * selected model can actually see images is the caller's gate — pi-ai
 * silently drops image parts on a text-only model, which would look like
 * the model ignoring the screenshot.
 */
import type { ImageContent } from "@earendil-works/pi-ai";

/** Types the model APIs accept as-is (pi-ai's own supported set). */
export const SUPPORTED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"] as const;

/** Longest edge kept. 1568px is the point past which the major vision
 *  models downscale anyway — sending more is pure cost. */
export const MAX_EDGE = 1568;
/** Per-image ceiling after re-encoding, under every provider's limit. */
export const MAX_BYTES = 4 * 1024 * 1024;
/** Per-message ceiling — a question, not an album. */
export const MAX_IMAGES = 4;

/** Re-encode targets, in order: PNG keeps screenshot text crisp, JPEG is
 *  the fallback when PNG comes out too big. */
const REENCODE: { mimeType: string; quality?: number; edge?: number }[] = [
  { mimeType: "image/png" },
  { mimeType: "image/jpeg", quality: 0.85 },
  { mimeType: "image/jpeg", quality: 0.6, edge: Math.round(MAX_EDGE / 2) },
];

export interface PastedImage extends ImageContent {
  /** Shown on the chip in the composer. */
  name: string;
  /** Decoded byte length — what the chip reports and the caps compare. */
  bytes: number;
}

export function isSupportedImage(mimeType: string): boolean {
  return (SUPPORTED_MIME as readonly string[]).includes(mimeType);
}

/** Fit within maxEdge, preserving aspect ratio. Never scales up. */
export function scaledSize(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/**
 * The image files on a paste/drop. Obsidian pastes a screenshot as a
 * single image/* file; a copied file manager selection can carry several.
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function base64Of(buffer: ArrayBuffer): string {
  // Desktop-only plugin, so Buffer is the cheap route (btoa needs a
  // per-byte string dance and blows the call stack on large images).
  return Buffer.from(buffer).toString("base64");
}

async function encode(
  bitmap: ImageBitmap,
  target: { mimeType: string; quality?: number; edge?: number },
): Promise<Blob | null> {
  const { width, height } = scaledSize(bitmap.width, bitmap.height, target.edge ?? MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), target.mimeType, target.quality));
}

/**
 * Normalize one pasted file into an ImageContent. Files that are already
 * small enough and in an accepted format pass through untouched — no
 * generation loss on a screenshot that was fine to begin with.
 *
 * Throws with a user-facing message; the caller surfaces it as-is.
 */
export async function toImageContent(file: File): Promise<PastedImage> {
  if (!file.type.startsWith("image/")) throw new Error(`"${file.name}" isn't an image.`);
  const name = file.name || "screenshot.png";

  const original = await file.arrayBuffer();
  if (isSupportedImage(file.type) && original.byteLength <= MAX_BYTES) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (bitmap && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE) {
      bitmap.close();
      return { type: "image", data: base64Of(original), mimeType: file.type, name, bytes: original.byteLength };
    }
    bitmap?.close();
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`Couldn't read "${name}" — it may be corrupt or an unsupported format.`);
  }
  try {
    for (const target of REENCODE) {
      const blob = await encode(bitmap, target);
      if (!blob) continue;
      const buffer = await blob.arrayBuffer();
      if (buffer.byteLength > MAX_BYTES) continue;
      return {
        type: "image",
        data: base64Of(buffer),
        mimeType: target.mimeType,
        name,
        bytes: buffer.byteLength,
      };
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`"${name}" is too large to send even after shrinking — try cropping it.`);
}

/** A data URL for rendering a thumbnail in the view. */
export function dataUrl(image: { data: string; mimeType: string }): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function describeBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
