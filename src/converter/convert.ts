import type { PDFWorker } from "pdfjs-dist";
import { loadEngineManifest, preloadPdfjsData, type PdfjsData } from "./assets";
import { collectEvidence } from "./evidence";
import { LayoutClient } from "./layoutClient";
import { createOcrWorker, type OcrWorker } from "./ocr";
import { createPdfWorker, openPdf, type PdfSession } from "./pdf";
import { ConversionError, type ConversionResult, type ConvertOptions, type PageLayout, type Warning } from "./types";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Owns every initialized engine. Treat it as opaque outside the converter modules. */
export class EngineSession {
  private busy = false;
  private stopped = false;
  private disposed = false;

  /** @internal */
  constructor(
    readonly pdfWorker: PDFWorker,
    readonly pdfData: PdfjsData,
    readonly ocrWorker: OcrWorker,
    readonly layout: LayoutClient,
  ) {}

  /** False after a conversion was cancelled mid-recognition or the session was disposed; create a new one. */
  get usable(): boolean {
    return !this.stopped && !this.disposed;
  }

  /** @internal */
  markStopped(): void {
    this.stopped = true;
  }

  /** @internal One conversion at a time. */
  begin(): void {
    if (!this.usable) throw new ConversionError("CONVERSION_FAILED", "Bộ xử lý đã dừng; cần khởi tạo lại trước khi chuyển đổi tiếp.");
    if (this.busy) throw new ConversionError("CONVERSION_FAILED", "Đang có một tác vụ chuyển đổi khác.");
    this.busy = true;
  }

  /** @internal */
  end(): void {
    this.busy = false;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pdfWorker.destroy();
    this.pdfData.clear();
    this.layout.dispose();
    await this.ocrWorker.terminate();
  }
}

async function startLayoutWorker(): Promise<LayoutClient> {
  const client = new LayoutClient();
  try {
    await client.ready();
  } catch {
    client.dispose();
    throw new ConversionError("ASSET_LOAD_FAILED", "Không tải được bộ dựng bố cục.");
  }
  return client;
}

/** Loads all engine assets; afterwards conversions need no network access. */
export async function initializeEngines(): Promise<EngineSession> {
  const manifest = await loadEngineManifest();
  const [data, pdf, ocr, layout] = await Promise.allSettled([
    preloadPdfjsData(manifest),
    createPdfWorker(),
    createOcrWorker(),
    startLayoutWorker(),
  ]);
  if (data.status === "fulfilled" && pdf.status === "fulfilled" && ocr.status === "fulfilled" && layout.status === "fulfilled") {
    return new EngineSession(pdf.value, data.value, ocr.value, layout.value);
  }
  // Do not leave a half-initialized engine running when one part failed.
  if (pdf.status === "fulfilled") pdf.value.destroy();
  if (ocr.status === "fulfilled") await ocr.value.terminate();
  if (layout.status === "fulfilled") layout.value.dispose();
  const failure = [data, pdf, ocr, layout].find((result) => result.status === "rejected");
  throw (failure as PromiseRejectedResult).reason;
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Converts one PDF to a DOCX blob, page by page: text layer or local OCR, layout reconstruction
 * in a worker, then export. Rejects with a ConversionError, or with the signal's AbortError when
 * cancelled; no partial document is ever returned.
 */
export async function convertPdf(file: File, options: ConvertOptions, session: EngineSession): Promise<ConversionResult> {
  session.begin();
  let pdf: PdfSession | undefined;
  try {
    const { signal, onProgress } = options;
    signal.throwIfAborted();
    onProgress({ phase: "validating" });
    pdf = await openPdf(file, session);
    const totalPages = pdf.pageCount;
    const layouts: PageLayout[] = [];
    const warnings: Warning[] = [];

    for (let page = 1; page <= totalPages; page++) {
      signal.throwIfAborted();
      onProgress({ phase: "analyzing", page, totalPages });
      const collected = await collectEvidence(pdf, session, page, {
        forceOcr: options.forceOcr,
        signal,
        onPhase: (phase) => onProgress({ phase, page, totalPages }),
      });
      signal.throwIfAborted();
      const reconstructed = await session.layout.reconstruct(collected.evidence);
      layouts.push(reconstructed.layout);
      warnings.push(...collected.warnings, ...reconstructed.warnings);
    }

    signal.throwIfAborted();
    onProgress({ phase: "building", totalPages });
    const bytes = await session.layout.build(layouts);
    signal.throwIfAborted();
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: DOCX_MIME }), warnings, pageCount: totalPages };
  } catch (error) {
    if (error instanceof ConversionError || isAbort(error)) throw error;
    throw new ConversionError("CONVERSION_FAILED", "Chuyển đổi không thành công.", { cause: error });
  } finally {
    // Not awaited: after a cancel the engine may already be disposed and closing would never finish.
    void pdf?.close().catch(() => undefined);
    session.end();
  }
}

const PREVIEW_WIDTH_PX = 560;

/**
 * Checks a chosen file with the same rules as conversion (size, structure, protection, page count)
 * and renders a small preview of page 1. A preview that cannot be drawn never blocks conversion.
 */
export async function inspectPdf(file: File, session: EngineSession): Promise<{ pageCount: number; preview?: Blob }> {
  session.begin();
  let pdf: PdfSession | undefined;
  try {
    pdf = await openPdf(file, session);
    const pageCount = pdf.pageCount;
    try {
      const rendered = await pdf.renderPage(1);
      try {
        const scale = Math.min(1, PREVIEW_WIDTH_PX / rendered.image.width);
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(rendered.image.width * scale)), Math.max(1, Math.round(rendered.image.height * scale)));
        canvas.getContext("2d")!.drawImage(rendered.image, 0, 0, canvas.width, canvas.height);
        return { pageCount, preview: await canvas.convertToBlob({ type: "image/png" }) };
      } finally {
        rendered.image.close();
      }
    } catch {
      return { pageCount };
    }
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new ConversionError("INVALID_PDF", "Không đọc được tệp PDF này.", { cause: error });
  } finally {
    await pdf?.close().catch(() => undefined);
    session.end();
  }
}
