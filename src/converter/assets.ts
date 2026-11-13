import { ConversionError } from "./types";

// Every engine file is served from this deployment; nothing is loaded from a CDN.
const BASE = `${import.meta.env.BASE_URL}engine/`;

export const ENGINE_MANIFEST_URL = `${BASE}manifest.json`;
export const PDFJS_WORKER_URL = `${BASE}pdfjs/pdf.worker.min.mjs`;
export const PDFJS_CMAP_URL = `${BASE}pdfjs/cmaps/`;
export const PDFJS_FONT_URL = `${BASE}pdfjs/standard_fonts/`;
export const PDFJS_WASM_URL = `${BASE}pdfjs/wasm/`;
export const TESSERACT_WORKER_URL = `${BASE}tesseract/worker.min.js`;
export const TESSERACT_CORE_URL = `${BASE}tesseract/core`;
export const TESSERACT_LANG_URL = `${BASE}tesseract/lang`;

export type EngineManifest = {
  pdfjs: { cmaps: string[]; standardFonts: string[]; wasm: string[] };
};

export type PdfjsBinaryKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";
export type PdfjsData = Map<string, Uint8Array>;

export const pdfjsDataKey = (kind: PdfjsBinaryKind, filename: string) => `${kind}:${filename}`;

const assetError = (what: string) =>
  new ConversionError("ASSET_LOAD_FAILED", `Không tải được tệp xử lý cần thiết (${what}).`);

async function fetchAsset(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw assetError(url);
  }
  // A single-page-app fallback answers a missing file with HTML and status 200.
  if (!response.ok || (response.headers.get("content-type") ?? "").includes("text/html")) {
    throw assetError(url);
  }
  return response;
}

export async function loadEngineManifest(): Promise<EngineManifest> {
  const response = await fetchAsset(ENGINE_MANIFEST_URL);
  try {
    return (await response.json()) as EngineManifest;
  } catch {
    throw assetError(ENGINE_MANIFEST_URL);
  }
}

export async function fetchBinaryAsset(url: string): Promise<Uint8Array> {
  const response = await fetchAsset(url);
  return new Uint8Array(await response.arrayBuffer());
}

/** Confirms a file exists and is not an HTML fallback, without downloading it. */
export async function checkAssetExists(url: string): Promise<void> {
  await fetchAsset(url, { method: "HEAD" });
}

/**
 * PDF.js loads CMaps, standard fonts and WebAssembly lazily. Loading them all up front
 * lets later conversions run with the network blocked.
 */
export async function preloadPdfjsData(manifest: EngineManifest): Promise<PdfjsData> {
  const jobs: { kind: PdfjsBinaryKind; filename: string; url: string }[] = [
    ...manifest.pdfjs.cmaps.map((filename) => ({ kind: "cMapUrl" as const, filename, url: `${PDFJS_CMAP_URL}${filename}` })),
    ...manifest.pdfjs.standardFonts.map((filename) => ({ kind: "standardFontDataUrl" as const, filename, url: `${PDFJS_FONT_URL}${filename}` })),
    ...manifest.pdfjs.wasm.map((filename) => ({ kind: "wasmUrl" as const, filename, url: `${PDFJS_WASM_URL}${filename}` })),
  ];
  const data: PdfjsData = new Map();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      data.set(pdfjsDataKey(job.kind, job.filename), await fetchBinaryAsset(job.url));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return data;
}

/** A PDF.js BinaryDataFactory that answers only from memory and never touches the network. */
export function createPreloadedBinaryDataFactory(data: PdfjsData) {
  return class PreloadedBinaryDataFactory {
    async fetch({ kind, filename }: { kind: PdfjsBinaryKind; filename: string }): Promise<Uint8Array> {
      const bytes = data.get(pdfjsDataKey(kind, filename));
      if (!bytes) throw new Error(`Engine data is not bundled: ${kind}/${filename}`);
      return bytes;
    }
  };
}
