import { recognizePage } from "./ocr";
import type { EngineSession } from "./convert";
import { cropToPng } from "./raster";
import type { PdfSession } from "./pdf";
import type { PageAnalysis, PageEvidence, Warning } from "./types";

const MAX_ARTWORK_PAGE_SHARE = 0.5;

export type CollectedPage = { evidence: PageEvidence; analysis: PageAnalysis; warnings: Warning[] };

/**
 * Gathers what the layout step needs for one page: the native text layer, or a local OCR
 * pass over the rendered page. `forceOcr` ignores the text layer even when it looks usable.
 */
export async function collectEvidence(
  pdf: PdfSession,
  session: EngineSession,
  pageNumber: number,
  options: { forceOcr: boolean; signal: AbortSignal; onPhase?: (phase: "extracting" | "ocr") => void },
): Promise<CollectedPage> {
  options.signal.throwIfAborted();
  const analysis = await pdf.analyzePage(pageNumber);
  const mode = options.forceOcr ? "ocr" : analysis.mode;
  options.onPhase?.(mode === "ocr" ? "ocr" : "extracting");

  if (mode === "ocr") {
    const rendered = await pdf.renderPage(pageNumber);
    const warnings = [...rendered.warnings];
    const evidence = await recognizePage(rendered, pageNumber, session, options.signal);
    return { evidence, analysis, warnings };
  }

  // Native page: keep small pictures (seals, signatures) by cropping them from a render.
  const pageArea = analysis.widthPt * analysis.heightPt;
  const pictures = analysis.imageBounds.filter((bounds) => (bounds.width * bounds.height) / pageArea < MAX_ARTWORK_PAGE_SHARE);
  const warnings: Warning[] = [];
  const images: PageEvidence["images"] = [];
  if (pictures.length > 0) {
    const rendered = await pdf.renderPage(pageNumber);
    warnings.push(...rendered.warnings);
    try {
      const scale = rendered.pixelWidth / rendered.widthPt;
      for (const bounds of pictures) images.push({ bounds, png: await cropToPng(rendered.image, bounds, scale) });
    } finally {
      rendered.image.close();
    }
  }
  return {
    evidence: {
      pageNumber,
      widthPt: analysis.widthPt,
      heightPt: analysis.heightPt,
      mode: "native",
      spans: analysis.spans,
      images,
      horizontalRules: analysis.horizontalRules,
      verticalRules: analysis.verticalRules,
    },
    analysis,
    warnings,
  };
}
