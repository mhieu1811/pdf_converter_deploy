import type { Bounds } from "./types";

export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

const RULE_MIN_LENGTH_PT = 24;
const RULE_MAX_THICKNESS_PT = 4;
const RULE_GAP_PX = 2;
const SEAL_MIN_SIDE_PT = 28;
const BLOCK_PX = 4;
const MERGE_BLOCKS = 3;
const SKEW_RANGE_DEG = 3;
const FIGURE_MIN_SIDE_PT = 34;
const FIGURE_MIN_FILL = 0.15;
const FIGURE_MAX_PAGE_SHARE = 0.7;

const chroma = (data: Uint8ClampedArray, offset: number) =>
  Math.max(data[offset], data[offset + 1], data[offset + 2]) - Math.min(data[offset], data[offset + 1], data[offset + 2]);
const luminance = (data: Uint8ClampedArray, offset: number) => 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];

/** Share of dark pixels on the page; used to tell a blank page from one OCR could not read. */
export function inkRatio(pixels: Pixels): number {
  let dark = 0;
  for (let offset = 0; offset < pixels.data.length; offset += 4) if (luminance(pixels.data, offset) < 128) dark++;
  return dark / (pixels.width * pixels.height);
}

type Rect = { a0: number; a1: number; b0: number; b1: number };

/** Finds long thin dark runs along the first axis; `ink(a, b)` reads position a within row b. */
function findThinRuns(length: number, rows: number, ink: (a: number, b: number) => boolean, minLength: number, maxThickness: number): Rect[] {
  const finished: Rect[] = [];
  let open: Rect[] = [];
  for (let row = 0; row < rows; row++) {
    const runs: [number, number][] = [];
    let start = -1;
    let lastInk = -1;
    for (let a = 0; a <= length; a++) {
      const on = a < length && ink(a, row);
      if (on) {
        if (start < 0) start = a;
        lastInk = a;
      } else if (start >= 0 && (a >= length || a - lastInk > RULE_GAP_PX)) {
        if (lastInk - start + 1 >= minLength) runs.push([start, lastInk]);
        start = -1;
      }
    }
    const next: Rect[] = [];
    for (const [a0, a1] of runs) {
      const match = open.find((rect) => {
        const shared = Math.min(rect.a1, a1) - Math.max(rect.a0, a0) + 1;
        return shared >= 0.8 * Math.min(rect.a1 - rect.a0 + 1, a1 - a0 + 1);
      });
      if (match) {
        open.splice(open.indexOf(match), 1);
        match.a0 = Math.min(match.a0, a0);
        match.a1 = Math.max(match.a1, a1);
        match.b1 = row;
        next.push(match);
      } else {
        next.push({ a0, a1, b0: row, b1: row });
      }
    }
    finished.push(...open);
    open = next;
  }
  finished.push(...open);
  return finished.filter((rect) => rect.b1 - rect.b0 + 1 <= maxThickness);
}

/** Ruled lines of tables on a scanned page, in points. Coloured ink is ignored. */
export function detectRules(pixels: Pixels, scale: number): { horizontal: Bounds[]; vertical: Bounds[] } {
  const { width, height, data } = pixels;
  const ink = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return chroma(data, offset) < 60 && luminance(data, offset) < 120;
  };
  const minLength = Math.round(RULE_MIN_LENGTH_PT * scale);
  const maxThickness = Math.round(RULE_MAX_THICKNESS_PT * scale);
  const horizontal = findThinRuns(width, height, (a, b) => ink(a, b), minLength, maxThickness)
    .map((rect): Bounds => ({ x: rect.a0 / scale, y: rect.b0 / scale, width: (rect.a1 - rect.a0 + 1) / scale, height: (rect.b1 - rect.b0 + 1) / scale }))
    .sort((p, q) => p.y - q.y || p.x - q.x);
  const vertical = findThinRuns(height, width, (a, b) => ink(b, a), minLength, maxThickness)
    .map((rect): Bounds => ({ x: rect.b0 / scale, y: rect.a0 / scale, width: (rect.b1 - rect.b0 + 1) / scale, height: (rect.a1 - rect.a0 + 1) / scale }))
    .sort((p, q) => p.x - q.x || p.y - q.y);
  return { horizontal, vertical };
}

/** Compact areas of coloured ink (seals, stamps, signatures) on a scanned page, in points. */
type BlockRegion = { x0: number; y0: number; x1: number; y1: number; cells: number[] };

/** Groups active grid blocks into regions; blocks within MERGE_BLOCKS of each other join. */
function labelBlocks(active: Uint8Array, columns: number, rows: number): BlockRegion[] {
  const label = new Int32Array(columns * rows).fill(-1);
  const regions: BlockRegion[] = [];
  for (let start = 0; start < active.length; start++) {
    if (!active[start] || label[start] >= 0) continue;
    const id = regions.length;
    const region: BlockRegion = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, cells: [] };
    const stack = [start];
    label[start] = id;
    while (stack.length) {
      const index = stack.pop()!;
      const column = index % columns;
      const row = Math.floor(index / columns);
      region.cells.push(index);
      region.x0 = Math.min(region.x0, column);
      region.x1 = Math.max(region.x1, column);
      region.y0 = Math.min(region.y0, row);
      region.y1 = Math.max(region.y1, row);
      for (let dy = -MERGE_BLOCKS; dy <= MERGE_BLOCKS; dy++) {
        for (let dx = -MERGE_BLOCKS; dx <= MERGE_BLOCKS; dx++) {
          const c = column + dx;
          const r = row + dy;
          if (c < 0 || r < 0 || c >= columns || r >= rows) continue;
          const neighbour = r * columns + c;
          if (active[neighbour] && label[neighbour] < 0) {
            label[neighbour] = id;
            stack.push(neighbour);
          }
        }
      }
    }
    regions.push(region);
  }
  return regions;
}

function regionToBounds(region: BlockRegion, pixels: Pixels, scale: number): Bounds {
  const margin = 2 * scale;
  const x0 = Math.max(0, region.x0 * BLOCK_PX - margin);
  const y0 = Math.max(0, region.y0 * BLOCK_PX - margin);
  const x1 = Math.min(pixels.width, (region.x1 + 1) * BLOCK_PX + margin);
  const y1 = Math.min(pixels.height, (region.y1 + 1) * BLOCK_PX + margin);
  return { x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale };
}

/** Compact areas of coloured ink (seals, stamps, signatures) on a scanned page, in points. */
export function detectColoredRegions(pixels: Pixels, scale: number): Bounds[] {
  const { width, height, data } = pixels;
  const columns = Math.ceil(width / BLOCK_PX);
  const rows = Math.ceil(height / BLOCK_PX);
  const counts = new Uint8Array(columns * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const block = Math.floor(y / BLOCK_PX) * columns + Math.floor(x / BLOCK_PX);
      if (counts[block] < 255 && chroma(data, offset) >= 70 && luminance(data, offset) < 215) counts[block]++;
    }
  }
  const active = counts.map((count) => (count >= 2 ? 1 : 0));
  const minSide = SEAL_MIN_SIDE_PT * scale;
  return labelBlocks(active, columns, rows)
    .filter((region) => Math.min((region.x1 - region.x0 + 1) * BLOCK_PX, (region.y1 - region.y0 + 1) * BLOCK_PX) >= minSide)
    .map((region) => regionToBounds(region, pixels, scale));
}

/**
 * Finds dark areas that neither text, rules nor seals account for. Large dense ones (photos,
 * logos, diagrams) are returned as figures to be kept as images; `unexplainedRatio` is the share
 * of all ink that is left over and could not be isolated (handwriting, smudges, noise).
 */
export function detectInkRegions(pixels: Pixels, scale: number, covered: Bounds[]): { figures: Bounds[]; unexplainedRatio: number } {
  const { width, height, data } = pixels;
  const skip = new Uint8Array(width * height);
  for (const rect of covered) {
    const x0 = Math.max(0, Math.floor(rect.x * scale) - 2);
    const y0 = Math.max(0, Math.floor(rect.y * scale) - 2);
    const x1 = Math.min(width, Math.ceil((rect.x + rect.width) * scale) + 2);
    const y1 = Math.min(height, Math.ceil((rect.y + rect.height) * scale) + 2);
    for (let y = y0; y < y1; y++) skip.fill(1, y * width + x0, y * width + x1);
  }

  const columns = Math.ceil(width / BLOCK_PX);
  const rows = Math.ceil(height / BLOCK_PX);
  const counts = new Uint16Array(columns * rows);
  let totalInk = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (luminance(data, (y * width + x) * 4) >= 128) continue;
      totalInk++;
      if (!skip[y * width + x]) counts[Math.floor(y / BLOCK_PX) * columns + Math.floor(x / BLOCK_PX)]++;
    }
  }
  if (totalInk === 0) return { figures: [], unexplainedRatio: 0 };

  const active = counts.map((count) => (count >= 2 ? 1 : 0)) as unknown as Uint8Array;
  const minSide = FIGURE_MIN_SIDE_PT * scale;
  const figures: Bounds[] = [];
  let unexplained = 0;
  for (const region of labelBlocks(active, columns, rows)) {
    const ink = region.cells.reduce((sum, cell) => sum + counts[cell], 0);
    const boxWidth = (region.x1 - region.x0 + 1) * BLOCK_PX;
    const boxHeight = (region.y1 - region.y0 + 1) * BLOCK_PX;
    const isFigure = Math.min(boxWidth, boxHeight) >= minSide && ink / (boxWidth * boxHeight) >= FIGURE_MIN_FILL && boxWidth * boxHeight <= FIGURE_MAX_PAGE_SHARE * width * height;
    if (isFigure) figures.push(regionToBounds(region, pixels, scale));
    else unexplained += ink;
  }
  return { figures, unexplainedRatio: unexplained / totalInk };
}

/**
 * Median thickness of dark strokes across the x-height band of a line, as a fraction of the
 * font size. Bold text has clearly thicker strokes than regular text of the same size.
 */
export function strokeWidthRatio(pixels: Pixels, region: { x0: number; x1: number; baseline: number }, fontPx: number): number {
  const { width, height, data } = pixels;
  const x0 = Math.max(0, Math.floor(region.x0));
  const x1 = Math.min(width, Math.ceil(region.x1));
  const top = Math.max(0, Math.round(region.baseline - 0.45 * fontPx));
  const bottom = Math.min(height - 1, Math.round(region.baseline - 0.08 * fontPx));
  const runs: number[] = [];
  for (let y = top; y <= bottom; y++) {
    let length = 0;
    for (let x = x0; x <= x1; x++) {
      const dark = x < x1 && luminance(data, (y * width + x) * 4) < 140;
      if (dark) length++;
      else if (length > 0) {
        if (length <= 0.4 * fontPx) runs.push(length);
        length = 0;
      }
    }
  }
  if (runs.length === 0) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor((runs.length - 1) / 2)] / fontPx;
}

/**
 * Angle in degrees (clockwise positive) by which the text lines of a scan are turned, found as
 * the rotation that makes the horizontal ink projection sharpest. Returns 0 when there is too
 * little ink to judge.
 */
export function estimateSkew(pixels: Pixels): number {
  const { width, height, data } = pixels;
  const stride = Math.max(1, Math.round(Math.min(width, height) / 400));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (luminance(data, (y * width + x) * 4) < 128) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 200) return 0;

  const bins = new Float64Array(Math.ceil((width + height) / stride) + 4);
  const score = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    bins.fill(0);
    for (let index = 0; index < xs.length; index++) {
      bins[Math.round((ys[index] * cos - xs[index] * sin + width) / stride)]++;
    }
    let total = 0;
    for (const count of bins) total += count * count;
    return total;
  };
  const search = (from: number, to: number, step: number, best: { angle: number; value: number }) => {
    for (let angle = from; angle <= to + 1e-9; angle += step) {
      const value = score(angle);
      if (value > best.value) best = { angle, value };
    }
    return best;
  };
  let best = search(-SKEW_RANGE_DEG, SKEW_RANGE_DEG, 0.25, { angle: 0, value: -1 });
  best = search(best.angle - 0.25, best.angle + 0.25, 0.05, { angle: best.angle, value: score(best.angle) });
  return Math.round(best.angle * 20) / 20;
}

/** Drops a flag that differs from both neighbours, which is almost always a misreading of one word. */
export function smoothFlags(flags: boolean[]): boolean[] {
  return flags.map((flag, index) => (index > 0 && index < flags.length - 1 && flags[index - 1] === flags[index + 1] && flags[index - 1] !== flag ? flags[index - 1] : flag));
}

export function bitmapToPixels(source: ImageBitmap | OffscreenCanvas): Pixels {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0);
  const { width, height, data } = context.getImageData(0, 0, source.width, source.height);
  return { width, height, data };
}

/** Rotates a page image about its centre; used to straighten a skewed scan. */
export function rotateCanvas(source: ImageBitmap | OffscreenCanvas, degrees: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/** Crops a region of a rendered page (bounds in points) into PNG bytes. */
export async function cropToPng(source: ImageBitmap | OffscreenCanvas, bounds: Bounds, scale: number): Promise<Uint8Array> {
  const x = Math.max(0, Math.floor(bounds.x * scale));
  const y = Math.max(0, Math.floor(bounds.y * scale));
  const width = Math.max(1, Math.min(source.width - x, Math.ceil(bounds.width * scale)));
  const height = Math.max(1, Math.min(source.height - y, Math.ceil(bounds.height * scale)));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.drawImage(source, x, y, width, height, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
