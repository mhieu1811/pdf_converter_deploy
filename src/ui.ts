import type { Warning } from "./converter/types";

const REQUIRED = ["Worker", "OffscreenCanvas", "WebAssembly", "createImageBitmap", "AbortController", "Blob"] as const;

/** Capabilities the converter needs that this browser lacks. Takes the global object so it can be tested. */
export function missingFeatures(env: Record<string, unknown>): string[] {
  const missing: string[] = REQUIRED.filter((name) => typeof env[name] === "undefined");
  const url = env.URL as { createObjectURL?: unknown } | undefined;
  if (typeof url?.createObjectURL !== "function") missing.push("URL.createObjectURL");
  return missing;
}

/** One line per distinct warning, with the pages it applies to. */
export function groupWarnings(warnings: Warning[]): { message: string; pages: number[] }[] {
  const groups = new Map<string, Set<number>>();
  for (const warning of warnings) {
    const pages = groups.get(warning.message) ?? new Set<number>();
    pages.add(warning.pageNumber);
    groups.set(warning.message, pages);
  }
  return [...groups].map(([message, pages]) => ({ message, pages: [...pages].sort((a, b) => a - b) }));
}
