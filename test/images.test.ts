/**
 * The canvas re-encoding path needs a DOM, so what's covered here is the
 * policy around it: what counts as an image, how far it gets scaled, and
 * what a paste event yields.
 */
import { describe, expect, it } from "vitest";
import { imageFilesFrom, isSupportedImage, scaledSize, MAX_EDGE } from "../src/llm/images";
import { withoutImageData } from "../src/llm/ask";
import type { Message } from "@earendil-works/pi-ai";

describe("isSupportedImage", () => {
  it("accepts the formats the model APIs take", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]) {
      expect(isSupportedImage(mime)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    expect(isSupportedImage("image/svg+xml")).toBe(false);
    expect(isSupportedImage("application/pdf")).toBe(false);
  });
});

describe("scaledSize", () => {
  it("leaves an image that already fits alone", () => {
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("fits the longest edge to the cap, keeping the aspect ratio", () => {
    expect(scaledSize(3840, 2160)).toEqual({ width: MAX_EDGE, height: 882 });
    expect(scaledSize(2160, 3840)).toEqual({ width: 882, height: MAX_EDGE });
  });

  it("never scales up", () => {
    expect(scaledSize(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it("never rounds an edge away to zero", () => {
    const out = scaledSize(10_000, 3, 100);
    expect(out.width).toBe(100);
    expect(out.height).toBe(1);
  });
});

describe("imageFilesFrom", () => {
  /** Minimal stand-in for the DataTransfer a paste/drop hands over. */
  function transfer(items: { kind: string; type: string; file?: File | null }[]): DataTransfer {
    return {
      items: items.map((i) => ({ ...i, getAsFile: () => i.file ?? null })),
    } as unknown as DataTransfer;
  }
  const png = new File([new Uint8Array([1, 2])], "shot.png", { type: "image/png" });

  it("picks out image files", () => {
    expect(imageFilesFrom(transfer([{ kind: "file", type: "image/png", file: png }]))).toEqual([png]);
  });

  it("ignores a plain text paste", () => {
    expect(imageFilesFrom(transfer([{ kind: "string", type: "text/plain" }]))).toEqual([]);
  });

  it("ignores non-image files", () => {
    const pdf = new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" });
    expect(imageFilesFrom(transfer([{ kind: "file", type: "application/pdf", file: pdf }]))).toEqual([]);
  });

  it("skips an item that yields no file", () => {
    expect(imageFilesFrom(transfer([{ kind: "file", type: "image/png", file: null }]))).toEqual([]);
  });

  it("survives no clipboard data at all", () => {
    expect(imageFilesFrom(null)).toEqual([]);
  });
});

describe("withoutImageData", () => {
  const imageTurn = (): Message[] => [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "AAAABBBBCCCC", mimeType: "image/png" },
      ],
      timestamp: 1,
    } as Message,
  ];

  it("replaces image bytes with a placeholder", () => {
    const out = withoutImageData(imageTurn());
    expect(JSON.stringify(out)).not.toContain("AAAABBBBCCCC");
    expect(out[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "text", text: "[image omitted from the saved transcript]" },
    ]);
  });

  it("does not mutate the live transcript the agent is still using", () => {
    const live = imageTurn();
    withoutImageData(live);
    expect((live[0]?.content as { type: string }[])[1]?.type).toBe("image");
  });

  it("passes string content and image-free messages through untouched", () => {
    const messages = [
      { role: "user", content: "plain text", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "parts" }], timestamp: 2 },
    ] as Message[];
    expect(withoutImageData(messages)).toEqual(messages);
  });
});
