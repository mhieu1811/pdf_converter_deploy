// Test-only entry points. main.tsx installs them only for `vite build --mode e2e`,
// so they never ship in the production bundle.
import { convertPdf, initializeEngines, type EngineSession } from "./converter/convert";
import { docxFileName } from "./converter/docx";
import { collectEvidence } from "./converter/evidence";
import { openPdf } from "./converter/pdf";
import { ConversionError, type Block, type Bounds, type CellBlock, type PageAnalysis, type Progress } from "./converter/types";

export type PageSummary = PageAnalysis & {
  render: { pixelWidth: number; pixelHeight: number; warnings: string[] };
};

export type AnalyzeResult =
  | { ok: true; pageCount: number; pages: PageSummary[] }
  | { ok: false; code: string; pageNumber?: number };

export type JsonCell =
  | { kind: "paragraph"; text: string; alignment: string; bold: boolean; italic: boolean; sizes: number[]; firstLineIndentPt?: number; leftIndentPt?: number; spaceBeforePt?: number }
  | { kind: "image"; bounds: Bounds; pngBytes: number };
export type JsonBlock = JsonCell | { kind: "table"; bordered: boolean; columnWidthsPt: number[]; rows: JsonCell[][][] };

export type LayoutSummary = {
  mode: string;
  warnings: string[];
  blocks: JsonBlock[];
  evidence: { spans: number; images: number; horizontalRules: number; verticalRules: number; fontSizes: number[]; ruleBounds: string[] };
};

export type ConvertSummary =
  | { ok: true; base64: string; mime: string; size: number; pageCount: number; warnings: string[]; progress: Progress[]; fileName: string; elapsedMs: number }
  | { ok: false; code: string; abortLatencyMs?: number };

export type E2eHooks = {
  initialize(): Promise<void>;
  analyze(base64: string, name: string): Promise<AnalyzeResult>;
  previewPng(base64: string, name: string, pageNumber: number): Promise<string>;
  layoutPage(base64: string, name: string, pageNumber: number, forceOcr: boolean): Promise<LayoutSummary>;
  convert(base64: string, name: string, options: { forceOcr: boolean; abortAfterMs?: number }): Promise<ConvertSummary>;
  convertConcurrently(base64: string, name: string): Promise<{ first: ConvertSummary; second: ConvertSummary }>;
  sessionUsable(): boolean;
  abortOcr(base64: string, name: string, pageNumber: number, delayMs: number): Promise<{ aborted: boolean; elapsedMs: number }>;
  dispose(): Promise<void>;
};

declare global {
  interface Window {
    __e2e?: E2eHooks;
  }
}

const toFile = (base64: string, name: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: "application/pdf" });
};

function describeCell(block: CellBlock): JsonCell {
  if (block.kind === "image") return { kind: "image", bounds: block.bounds, pngBytes: block.png.length };
  return {
    kind: "paragraph",
    text: block.spans.map((span) => span.text).join(""),
    alignment: block.alignment,
    bold: block.spans.every((span) => span.bold),
    italic: block.spans.every((span) => span.italic),
    sizes: [...new Set(block.spans.map((span) => Math.round(span.fontSizePt * 2) / 2))],
    firstLineIndentPt: block.firstLineIndentPt,
    leftIndentPt: block.leftIndentPt,
    spaceBeforePt: block.spaceBeforePt,
  };
}

function describeBlock(block: Block): JsonBlock {
  if (block.kind !== "table") return describeCell(block);
  return { kind: "table", bordered: block.bordered, columnWidthsPt: block.columnWidthsPt, rows: block.rows.map((row) => row.cells.map((cell) => cell.map(describeCell))) };
}

export function installE2eHooks(): void {
  let session: EngineSession | undefined;
  const requireSession = () => {
    if (!session) throw new Error("Engines are not initialized");
    return session;
  };

  window.__e2e = {
    async initialize() {
      session = await initializeEngines().catch((error) => {
        if (error instanceof ConversionError) throw new Error(`ConversionError:${error.code}`);
        throw error;
      });
    },

    async analyze(base64, name) {
      let pdf;
      try {
        pdf = await openPdf(toFile(base64, name), requireSession());
      } catch (error) {
        if (error instanceof ConversionError) return { ok: false, code: error.code, pageNumber: error.pageNumber };
        throw error;
      }
      try {
        const pages: PageSummary[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.pageCount; pageNumber++) {
          const analysis = await pdf.analyzePage(pageNumber);
          const rendered = await pdf.renderPage(pageNumber);
          rendered.image.close();
          pages.push({
            ...analysis,
            render: {
              pixelWidth: rendered.pixelWidth,
              pixelHeight: rendered.pixelHeight,
              warnings: rendered.warnings.map((warning) => warning.code),
            },
          });
        }
        return { ok: true, pageCount: pdf.pageCount, pages };
      } finally {
        await pdf.close();
      }
    },

    async previewPng(base64, name, pageNumber) {
      const pdf = await openPdf(toFile(base64, name), requireSession());
      try {
        const rendered = await pdf.renderPage(pageNumber);
        const canvas = document.createElement("canvas");
        canvas.width = rendered.pixelWidth;
        canvas.height = rendered.pixelHeight;
        canvas.getContext("2d")!.drawImage(rendered.image, 0, 0);
        rendered.image.close();
        return canvas.toDataURL("image/png");
      } finally {
        await pdf.close();
      }
    },

    async layoutPage(base64, name, pageNumber, forceOcr) {
      const engines = requireSession();
      const pdf = await openPdf(toFile(base64, name), engines);
      try {
        const { evidence, warnings: pageWarnings } = await collectEvidence(pdf, engines, pageNumber, { forceOcr, signal: new AbortController().signal });
        const { layout, warnings } = await engines.layout.reconstruct(evidence);
        return {
          mode: evidence.mode,
          warnings: [...pageWarnings, ...warnings].map((warning) => warning.code),
          blocks: layout.blocks.map(describeBlock),
          evidence: {
            spans: evidence.spans.length,
            images: evidence.images.length,
            horizontalRules: evidence.horizontalRules.length,
            verticalRules: evidence.verticalRules.length,
            fontSizes: [...new Set(evidence.spans.map((span) => Math.round(span.fontSizePt * 2) / 2))],
            ruleBounds: [...evidence.horizontalRules, ...evidence.verticalRules].map((bounds) => bounds.x.toFixed(0) + "," + bounds.y.toFixed(0) + " " + bounds.width.toFixed(0) + "x" + bounds.height.toFixed(0)),
          },
        };
      } catch (error) {
        if (error instanceof ConversionError) throw new Error(`ConversionError:${error.code}`);
        throw error;
      } finally {
        await pdf.close();
      }
    },

    async abortOcr(base64, name, pageNumber, delayMs) {
      const engines = requireSession();
      const pdf = await openPdf(toFile(base64, name), engines);
      const controller = new AbortController();
      const started = performance.now();
      setTimeout(() => controller.abort(), delayMs);
      let abortedAt = 0;
      try {
        await collectEvidence(pdf, engines, pageNumber, { forceOcr: true, signal: controller.signal });
        return { aborted: false, elapsedMs: performance.now() - started };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") abortedAt = performance.now();
        else throw error;
        return { aborted: true, elapsedMs: abortedAt - started - delayMs };
      } finally {
        await pdf.close();
      }
    },

    sessionUsable() {
      return Boolean(session?.usable);
    },

    async convert(base64, name, options) {
      return runConvert(requireSession(), base64, name, options);
    },

    async convertConcurrently(base64, name) {
      const engines = requireSession();
      const first = runConvert(engines, base64, name, { forceOcr: false });
      const second = runConvert(engines, base64, name, { forceOcr: false });
      return { first: await first, second: await second };
    },

    async dispose() {
      await session?.dispose();
      session = undefined;
    },
  };
}

async function runConvert(engines: EngineSession, base64: string, name: string, options: { forceOcr: boolean; abortAfterMs?: number }): Promise<ConvertSummary> {
  const controller = new AbortController();
  let abortedAt: number | undefined;
  if (options.abortAfterMs !== undefined) {
    setTimeout(() => {
      abortedAt = performance.now();
      controller.abort();
    }, options.abortAfterMs);
  }
  const progress: Progress[] = [];
  const started = performance.now();
  try {
    const result = await convertPdf(toFile(base64, name), { forceOcr: options.forceOcr, signal: controller.signal, onProgress: (item) => progress.push(item) }, engines);
    const elapsedMs = performance.now() - started;
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return {
      ok: true,
      base64: btoa(binary),
      mime: result.blob.type,
      size: result.blob.size,
      pageCount: result.pageCount,
      warnings: result.warnings.map((warning) => warning.code),
      progress,
      fileName: docxFileName(name),
      elapsedMs,
    };
  } catch (error) {
    if (error instanceof ConversionError) return { ok: false, code: error.code };
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, code: "ABORTED", abortLatencyMs: abortedAt === undefined ? undefined : performance.now() - abortedAt };
    }
    throw error;
  }
}
