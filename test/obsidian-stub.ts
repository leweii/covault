/**
 * Minimal obsidian API stub for vitest (the real package is types-only —
 * it has no runtime entry point outside the app). Only what unit tests
 * actually touch; extend as tests grow.
 */
export class Notice {
  constructor(public message: string) {}
}

export function requestUrl(): never {
  throw new Error("requestUrl is not available in tests — inject a test http client instead");
}

export type RequestUrlResponse = {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
};

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class FileSystemAdapter {}
