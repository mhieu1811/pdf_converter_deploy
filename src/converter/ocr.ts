import { createWorker, PSM, type Line as OcrLine, type Page as OcrPage, type Worker } from "tesseract.js";
import { TESSERACT_CORE_URL, TESSERACT_LANG_URL, TESSERACT_WORKER_URL, checkAssetExists } from "./assets";
import type { EngineSession } from "./convert";
import { keepTableRules } from "./layout";
import { bitmapToPixels, cropToPng, detectColoredRegions, detectInkRegions, detectRules, estimateSkew, inkRatio, rotateCanvas, smoothFlags, strokeWidthRatio, type Pixels } from "./raster";
import { ConversionError, type Bounds, type PageEvidence, type RenderedPage, type TextSpan } from "./types";

export type OcrWorker = Worker;

const LANGUAGES = ["vie", "eng"];

/**
 * Loads the self-hosted Tesseract core and the Vietnamese and English models. The OCR
 * worker fetches them itself during creation, so afterwards recognition needs no network.
 */
export async function createOcrWorker(): Promise<OcrWorker> {
  // Tesseract.js never settles its promise when a model fails to load, so check them first.
  await Promise.all(LANGUAGES.map((code) => checkAssetExists(`${TESSERACT_LANG_URL}/${code}.traineddata.gz`)));
  await checkAssetExists(TESSERACT_WORKER_URL);

  // Later worker failures are raced in for the same reason.
  let fail!: (reason: unknown) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const created = createWorker(LANGUAGES, 1, {
    workerPath: TESSERACT_WORKER_URL,
    corePath: TESSERACT_CORE_URL,
    langPath: TESSERACT_LANG_URL,
    gzip: true,
    // Nothing should be written to browser storage.
    cacheMethod: "none",
    workerBlobURL: false,
    errorHandler: fail,
  });
  try {
    return await Promise.race([created, failed]);
  } catch (cause) {
    throw new ConversionError("ASSET_LOAD_FAILED", "Không tải được bộ nhận dạng chữ (OCR).", { cause });
  }
}

// Tesseract reports a line's "row height"; this converts it to an em size in points.
const ROW_HEIGHT_PER_EM = 1.08;

const inside = (x: number, y: number, bounds: Bounds) =>
  x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;

function recognizeOrAbort(session: EngineSession, image: OffscreenCanvas, signal: AbortSignal, parameters: Record<string, string> = {}): Promise<OcrPage> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      // The only way to stop a running recognition is to end the worker; the session must be recreated.
      session.markStopped();
      void session.ocrWorker.terminate();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    // A signal that was aborted while the page was being prepared never fires again.
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    // Tesseract parameters given here apply to this call only and are restored afterwards.
    session.ocrWorker
      .recognize(image, parameters as never, { blocks: true })
      .then((result) => resolve(result.data), reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const BOLD_STROKE_RATIO = 0.128;
const SIZE_SNAP_TOLERANCE = 0.35;
const MIN_DESKEW_DEGREES = 0.3;
// Isolated punctuation read from scanner noise is dropped; real punctuation is read with higher confidence.
const MIN_PUNCTUATION_CONFIDENCE = 75;
const MAX_LINE_HEIGHT_PT = 70;
const MIN_WORD_CONFIDENCE_IN_FIGURE = 85;
const MIN_INK_RATIO = 0.002;
// Real scans read at about 93-96 mean confidence; a page of handwriting or smudges reads near 55.
const MIN_MEAN_CONFIDENCE = 70;
const MAX_UNEXPLAINED_INK = 0.2;
// Second-pass reading of doubtful words.
const REFINE_BELOW_CONFIDENCE = 80;
const MAX_REFINED_WORDS = 40;
const RESCUE_MIN_CONFIDENCE = 60;
const RESCUE_AGREEING_MIN_CONFIDENCE = 35;
const PUNCTUATION_MIN_CONFIDENCE = 85;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

type Candidate = {
  /** Index into spans, or undefined for a word that was dropped as noise but is big enough to be a word. */
  spanIndex: number | undefined;
  text: string;
  confidence: number;
  boxPx: { x0: number; y0: number; x1: number; y1: number };
  baselinePx: number;
  fontSizePt: number;
  bold: boolean;
};

const NUMERIC = /^\d[\d.,:/-]*\d$/;

function wordsToSpans(
  page: OcrPage,
  scale: number,
  excluded: Bounds[],
  pixels: Pixels,
): { spans: TextSpan[]; wordBoxes: Bounds[]; confidences: number[]; candidates: Candidate[] } {
  // Lines taller than any real text (Tesseract reading a photo or a smudge) are not text.
  const lines: OcrLine[] = (page.blocks ?? [])
    .flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines))
    .filter((line) => (line.bbox.y1 - line.bbox.y0) / scale <= MAX_LINE_HEIGHT_PT);
  const rawSizes = lines.map((line) => {
    const rowHeightPx = line.rowAttributes?.rowHeight || (line.bbox.y1 - line.bbox.y0) * 0.8;
    return Math.max(4, rowHeightPx / scale / ROW_HEIGHT_PER_EM);
  });
  // Most of a page is one font size; noisy per-line estimates are snapped to it, then to whole points.
  const bodySize = rawSizes.length ? medianOf(rawSizes) : 12;
  const spans: TextSpan[] = [];
  const wordBoxes: Bounds[] = [];
  const confidences: number[] = [];
  const candidates: Candidate[] = [];

  lines.forEach((line, index) => {
    const estimate = rawSizes[index];
    // Short lines (one or two words, or only x-height letters) measure unreliably, so they follow the body size.
    const reliable = line.words.length > 2;
    const snap = Math.abs(estimate - bodySize) <= SIZE_SNAP_TOLERANCE * bodySize || (!reliable && estimate <= bodySize * 1.35);
    const fontSizePt = Math.max(8, Math.round(snap ? bodySize : estimate));
    const { x0, y0, x1, y1 } = line.baseline ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    const slope = x1 !== x0 ? (y1 - y0) / (x1 - x0) : 0;
    // Flatten the skew of each line so that its words share one baseline.
    const baselinePx = line.baseline && (x1 !== x0 || y1 !== y0) ? y0 + (line.bbox.x0 - x0) * slope : line.bbox.y1 - (line.rowAttributes?.descenders ?? 0);
    const fontPx = fontSizePt * scale;
    let previousBold: boolean = false;
    const firstSpan = spans.length;
    for (const word of line.words) {
      const text = word.text.trim();
      if (!text) continue;
      const boxPx = { x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 };
      const isNoise = !/[\p{L}\p{N}]/u.test(text) && word.confidence < MIN_PUNCTUATION_CONFIDENCE;
      if (isNoise) {
        // A speck is small; a word-sized area that read as noise gets a second look.
        if ((boxPx.x1 - boxPx.x0) / scale >= 12 && (boxPx.y1 - boxPx.y0) / scale >= 8) {
          candidates.push({ spanIndex: undefined, text, confidence: word.confidence, boxPx, baselinePx, fontSizePt, bold: previousBold });
        }
        continue;
      }
      // Tesseract lines can run across side-by-side columns, so boldness is judged per word.
      const ratio = strokeWidthRatio(pixels, { x0: word.bbox.x0, x1: word.bbox.x1, baseline: baselinePx }, fontPx);
      const bold: boolean = ratio === 0 ? previousBold : ratio > BOLD_STROKE_RATIO;
      previousBold = bold;
      const bounds: Bounds = {
        x: word.bbox.x0 / scale,
        y: baselinePx / scale - fontSizePt,
        width: (word.bbox.x1 - word.bbox.x0) / scale,
        height: fontSizePt,
      };
      if (excluded.some((region) => inside(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, region))) continue;
      if (word.confidence < REFINE_BELOW_CONFIDENCE || NUMERIC.test(text)) {
        candidates.push({ spanIndex: spans.length, text, confidence: word.confidence, boxPx, baselinePx, fontSizePt, bold });
      }
      spans.push({ text, bounds, fontSizePt, bold, italic: false });
      wordBoxes.push({ x: word.bbox.x0 / scale, y: word.bbox.y0 / scale, width: (word.bbox.x1 - word.bbox.x0) / scale, height: (word.bbox.y1 - word.bbox.y0) / scale });
      confidences.push(word.confidence);
    }
    // One word that looks bold between two that do not is a misreading of stroke width, not formatting.
    const lineSpans = spans.slice(firstSpan);
    smoothFlags(lineSpans.map((span) => span.bold)).forEach((bold, offset) => {
      lineSpans[offset].bold = bold;
    });
  });
  return { spans, wordBoxes, confidences, candidates };
}

const DIGIT_WHITELIST = "0123456789.,:/-";

/** Reads one word-sized area again, enlarged and as a single line. */
async function readRegion(session: EngineSession, source: OffscreenCanvas, boxPx: Candidate["boxPx"], whitelist: string, signal: AbortSignal): Promise<{ text: string; confidence: number } | undefined> {
  const pad = 6;
  const x = Math.max(0, Math.floor(boxPx.x0 - pad));
  const y = Math.max(0, Math.floor(boxPx.y0 - pad));
  const width = Math.max(1, Math.min(source.width - x, Math.ceil(boxPx.x1 - boxPx.x0 + 2 * pad)));
  const height = Math.max(1, Math.min(source.height - y, Math.ceil(boxPx.y1 - boxPx.y0 + 2 * pad)));
  const crop = new OffscreenCanvas(width * 2, height * 2);
  const context = crop.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, crop.width, crop.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(source, x, y, width, height, 0, 0, crop.width, crop.height);
  const parameters: Record<string, string> = { tessedit_pageseg_mode: PSM.SINGLE_LINE };
  if (whitelist) parameters.tessedit_char_whitelist = whitelist;
  const data = await recognizeOrAbort(session, crop, signal, parameters);
  const text = data.text.trim().replace(/\s+/g, " ");
  return text ? { text, confidence: data.confidence } : undefined;
}

const sameDigits = (a: string, b: string) => a.replace(/\D/g, "") === b.replace(/\D/g, "");
const marksOf = (text: string) => (text.normalize("NFD").match(/[\u0300-\u036f]/g) ?? []).length;

/**
 * A second, focused read of the words most likely to be wrong: low-confidence words, numbers,
 * and word-sized areas that first read as noise. A better reading replaces the first one; a
 * rescued word is added. Bounded per page, so the cost stays small.
 */
async function refineWords(session: EngineSession, canvas: OffscreenCanvas, scale: number, read: ReturnType<typeof wordsToSpans>, signal: AbortSignal): Promise<void> {
  const targets = [...read.candidates].sort((a, b) => Number(a.spanIndex !== undefined) - Number(b.spanIndex !== undefined) || a.confidence - b.confidence).slice(0, MAX_REFINED_WORDS);
  if (targets.length === 0) return;
  for (const candidate of targets) {
    const numeric = NUMERIC.test(candidate.text);
    const attempts = [await readRegion(session, canvas, candidate.boxPx, "", signal)];
    if (numeric || candidate.spanIndex === undefined) attempts.push(await readRegion(session, canvas, candidate.boxPx, DIGIT_WHITELIST, signal));
    const best = attempts.filter((attempt): attempt is { text: string; confidence: number } => Boolean(attempt)).sort((a, b) => b.confidence - a.confidence)[0];
    if (!best) continue;
    if (candidate.spanIndex === undefined) {
      // Rescue: only something that really reads as text, never a speck. Two independent readings that
      // agree (free text and digits-only) are accepted even when each is only moderately certain.
      const [free, digits] = attempts;
      const agree = Boolean(free && digits && free.text === digits.text && Math.min(free.confidence, digits.confidence) >= RESCUE_AGREEING_MIN_CONFIDENCE);
      if (!/[\p{L}\p{N}]/u.test(best.text) || best.text.length < 2 || (best.confidence < RESCUE_MIN_CONFIDENCE && !agree)) continue;
      const bounds: Bounds = {
        x: candidate.boxPx.x0 / scale,
        y: candidate.baselinePx / scale - candidate.fontSizePt,
        width: (candidate.boxPx.x1 - candidate.boxPx.x0) / scale,
        height: candidate.fontSizePt,
      };
      read.spans.push({ text: best.text, bounds, fontSizePt: candidate.fontSizePt, bold: candidate.bold, italic: false });
      read.wordBoxes.push({ x: candidate.boxPx.x0 / scale, y: candidate.boxPx.y0 / scale, width: (candidate.boxPx.x1 - candidate.boxPx.x0) / scale, height: (candidate.boxPx.y1 - candidate.boxPx.y0) / scale });
      read.confidences.push(best.confidence);
    } else if (best.text !== candidate.text) {
      // A second reading of a different shape is not trusted just for scoring higher: it must not lose
      // letters or diacritics. The one exception is restoring punctuation inside a number.
      const restoresPunctuation = numeric && sameDigits(best.text, candidate.text) && NUMERIC.test(best.text) && best.confidence >= PUNCTUATION_MIN_CONFIDENCE;
      const losesNothing = best.text.length >= candidate.text.length && marksOf(best.text) >= marksOf(candidate.text);
      if (restoresPunctuation || (best.confidence > candidate.confidence && losesNothing)) {
        read.spans[candidate.spanIndex].text = best.text;
        read.confidences[candidate.spanIndex] = Math.max(candidate.confidence, best.confidence);
      }
    }
  }
}

/**
 * Reads a rendered page with Tesseract and finds its ruled lines and seals from the pixels.
 * Words inside a seal are dropped so its lettering is not duplicated as text.
 */
export async function recognizePage(rendered: RenderedPage, pageNumber: number, session: EngineSession, signal: AbortSignal): Promise<PageEvidence> {
  const { image } = rendered;
  try {
    signal.throwIfAborted();
    const scale = rendered.pixelWidth / rendered.widthPt;
    // A tilted scan is straightened first so that its lines, rules and seals are measured upright.
    let page: ImageBitmap | OffscreenCanvas = image;
    let pixels = bitmapToPixels(page);
    const skew = estimateSkew(pixels);
    if (Math.abs(skew) >= MIN_DESKEW_DEGREES) {
      page = rotateCanvas(image, -skew);
      pixels = bitmapToPixels(page);
    }
    const sealBounds = detectColoredRegions(pixels, scale);
    const detected = detectRules(pixels, scale);
    const rules = keepTableRules(detected.horizontal, detected.vertical);
    const canvas = new OffscreenCanvas(page.width, page.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(page, 0, 0);
    // Ruled lines confuse Tesseract and make it skip cells, so they are painted out before reading.
    context.fillStyle = "#fff";
    for (const rule of [...rules.horizontal, ...rules.vertical]) {
      context.fillRect(rule.x * scale - 2, rule.y * scale - 2, rule.width * scale + 4, rule.height * scale + 4);
    }

    const result = await recognizeOrAbort(session, canvas, signal);
    const read = wordsToSpans(result, scale, sealBounds, pixels);
    await refineWords(session, canvas, scale, read, signal);
    const { figures, unexplainedRatio } = detectInkRegions(pixels, scale, [...read.wordBoxes, ...rules.horizontal, ...rules.vertical, ...sealBounds]);
    // Words that Tesseract hallucinated on top of a photo or logo are not text.
    const spans = read.spans.filter((span, index) => read.confidences[index] >= MIN_WORD_CONFIDENCE_IN_FIGURE || !figures.some((figure) => inside(span.bounds.x + span.bounds.width / 2, span.bounds.y + span.bounds.height / 2, figure)));
    const keptRegions = [...sealBounds, ...figures];
    const meanConfidence = read.confidences.length ? read.confidences.reduce((a, b) => a + b, 0) / read.confidences.length : 100;
    const hasInk = inkRatio(pixels) > MIN_INK_RATIO;
    if (hasInk && ((spans.length === 0 && keptRegions.length === 0) || unexplainedRatio > MAX_UNEXPLAINED_INK || meanConfidence < MIN_MEAN_CONFIDENCE)) {
      throw new ConversionError("QUALITY_FAILURE", `Trang ${pageNumber} có nội dung không đọc được và không thể giữ lại nguyên vẹn (ví dụ chữ viết tay hoặc vết bẩn).`, { pageNumber });
    }
    const images = await Promise.all(keptRegions.map(async (bounds) => ({ bounds, png: await cropToPng(page, bounds, scale) })));
    return {
      pageNumber,
      widthPt: rendered.widthPt,
      heightPt: rendered.heightPt,
      mode: "ocr",
      spans,
      images,
      horizontalRules: rules.horizontal,
      verticalRules: rules.vertical,
    };
  } finally {
    image.close();
  }
}
