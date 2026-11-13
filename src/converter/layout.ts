import type {
  Block,
  Bounds,
  CellBlock,
  ImageBlock,
  PageEvidence,
  PageLayout,
  ParagraphBlock,
  TableBlock,
  TextSpan,
  Warning,
} from "./types";

const RULE_TOLERANCE_PT = 2;
const TABLE_COVERAGE = 0.95;

type Interval = { from: number; to: number };
type Box = { x0: number; y0: number; x1: number; y1: number };
type Image = PageEvidence["images"][number];

type Segment = { runs: TextSpan[]; text: string; x0: number; x1: number; top: number; bottom: number; size: number };
type TextLine = { segments: Segment[]; x0: number; x1: number; top: number; bottom: number; size: number };

type FlowItem = { top: number; bottom: number; block: Block };

const centerX = (b: Bounds) => b.x + b.width / 2;
const centerY = (b: Bounds) => b.y + b.height / 2;
const nfc = (text: string) => text.normalize("NFC");
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
};
const round = (value: number) => Math.round(value * 2) / 2;

// ---------------------------------------------------------------------------
// Text cleanup

function overlapRatio(a: Bounds, b: Bounds): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / Math.max(1e-6, Math.min(a.width * a.height, b.width * b.height));
}

/** Drops blank spans and spans that repeat text already placed at the same position. */
function cleanSpans(spans: TextSpan[]): TextSpan[] {
  const sorted = spans
    .filter((span) => span.text.trim() !== "")
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const kept: TextSpan[] = [];
  for (const span of sorted) {
    const text = nfc(span.text.trim());
    let duplicate = false;
    for (let index = kept.length - 1; index >= 0; index--) {
      const other = kept[index];
      if (other.bounds.y + other.bounds.height + 2 < span.bounds.y) break;
      const otherText = nfc(other.text.trim());
      if ((otherText === text || otherText.includes(text) || text.includes(otherText)) && overlapRatio(other.bounds, span.bounds) > 0.5) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(span);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Ruled tables

type HLine = { y: number; x0: number; x1: number };
type VLine = { x: number; y0: number; y1: number };
type TableRegion = { xs: number[]; ys: number[]; complete: boolean };

function cluster(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const value of sorted) {
    const last = groups.at(-1);
    if (last && value - last[0] <= RULE_TOLERANCE_PT) last.push(value);
    else groups.push([value]);
  }
  return groups.map((group) => group.reduce((a, b) => a + b, 0) / group.length);
}

function mergeHorizontal(rules: Bounds[]): HLine[] {
  const lines = rules.map((rule) => ({ y: centerY(rule), x0: rule.x, x1: rule.x + rule.width })).sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const merged: HLine[] = [];
  for (const line of lines) {
    const last = merged.at(-1);
    if (last && Math.abs(line.y - last.y) <= RULE_TOLERANCE_PT && line.x0 <= last.x1 + RULE_TOLERANCE_PT) last.x1 = Math.max(last.x1, line.x1);
    else merged.push({ ...line });
  }
  return merged;
}

function mergeVertical(rules: Bounds[]): VLine[] {
  const lines = rules.map((rule) => ({ x: centerX(rule), y0: rule.y, y1: rule.y + rule.height })).sort((a, b) => a.x - b.x || a.y0 - b.y0);
  const merged: VLine[] = [];
  for (const line of lines) {
    const last = merged.at(-1);
    if (last && Math.abs(line.x - last.x) <= RULE_TOLERANCE_PT && line.y0 <= last.y1 + RULE_TOLERANCE_PT) last.y1 = Math.max(last.y1, line.y1);
    else merged.push({ ...line });
  }
  return merged;
}

function detectTables(horizontalRules: Bounds[], verticalRules: Bounds[]): TableRegion[] {
  const h = mergeHorizontal(horizontalRules);
  const v = mergeVertical(verticalRules);
  const parent = Array.from({ length: h.length + v.length }, (_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  h.forEach((hl, hi) =>
    v.forEach((vl, vi) => {
      const touches =
        vl.x >= hl.x0 - RULE_TOLERANCE_PT && vl.x <= hl.x1 + RULE_TOLERANCE_PT && hl.y >= vl.y0 - RULE_TOLERANCE_PT && hl.y <= vl.y1 + RULE_TOLERANCE_PT;
      if (touches) parent[find(hi)] = find(h.length + vi);
    }),
  );

  const regions: TableRegion[] = [];
  const groups = new Map<number, number[]>();
  parent.forEach((_, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), index]));
  for (const members of groups.values()) {
    const hs = members.filter((index) => index < h.length).map((index) => h[index]);
    const vs = members.filter((index) => index >= h.length).map((index) => v[index - h.length]);
    const ys = cluster(hs.map((line) => line.y));
    const xs = cluster(vs.map((line) => line.x));
    if (ys.length < 2 || xs.length < 2) continue;
    const width = xs.at(-1)! - xs[0];
    const height = ys.at(-1)! - ys[0];
    const covered = (lengths: Interval[], from: number, to: number) =>
      lengths.reduce((sum, item) => sum + Math.max(0, Math.min(item.to, to) - Math.max(item.from, from)), 0);
    const horizontalOk = ys.every((y) => covered(hs.filter((line) => Math.abs(line.y - y) <= RULE_TOLERANCE_PT).map((line) => ({ from: line.x0, to: line.x1 })), xs[0], xs.at(-1)!) >= TABLE_COVERAGE * width);
    const verticalOk = xs.every((x) => covered(vs.filter((line) => Math.abs(line.x - x) <= RULE_TOLERANCE_PT).map((line) => ({ from: line.y0, to: line.y1 })), ys[0], ys.at(-1)!) >= TABLE_COVERAGE * height);
    regions.push({ xs, ys, complete: horizontalOk && verticalOk });
  }
  return regions.sort((a, b) => a.ys[0] - b.ys[0]);
}

const regionBounds = (region: TableRegion): Bounds => ({
  x: region.xs[0],
  y: region.ys[0],
  width: region.xs.at(-1)! - region.xs[0],
  height: region.ys.at(-1)! - region.ys[0],
});

/** Keeps only the rules that form ruled grids; stray long strokes (letter tops, underlines) are dropped. */
export function keepTableRules(horizontal: Bounds[], vertical: Bounds[]): { horizontal: Bounds[]; vertical: Bounds[] } {
  const regions = detectTables(horizontal, vertical).map(regionBounds);
  const within = (rule: Bounds) =>
    regions.some(
      (region) =>
        rule.x >= region.x - 3 && rule.y >= region.y - 3 && rule.x + rule.width <= region.x + region.width + 3 && rule.y + rule.height <= region.y + region.height + 3,
    );
  return { horizontal: horizontal.filter(within), vertical: vertical.filter(within) };
}

const insideBounds = (x: number, y: number, bounds: Bounds) =>
  x >= bounds.x - 1 && x <= bounds.x + bounds.width + 1 && y >= bounds.y - 1 && y <= bounds.y + bounds.height + 1;

// ---------------------------------------------------------------------------
// Lines and segments

const sameStyle = (a: TextSpan, b: TextSpan) => a.bold === b.bold && a.italic === b.italic && Math.abs(a.fontSizePt - b.fontSizePt) <= 0.6;

function buildSegment(spans: TextSpan[], wordSpans: boolean): Segment {
  const runs: TextSpan[] = [];
  let previous: TextSpan | undefined;
  for (const span of spans) {
    const text = nfc(span.text);
    let prefix = "";
    if (previous) {
      const gap = span.bounds.x - (previous.bounds.x + previous.bounds.width);
      const spaced = /\s$/.test(runs.at(-1)!.text) || /^\s/.test(text);
      // OCR spans are whole words (italic overlap can hide the gap); native spans are runs.
      if ((wordSpans || gap > 0.18 * Math.max(span.fontSizePt, previous.fontSizePt)) && !spaced) prefix = " ";
    }
    const last = runs.at(-1);
    if (last && sameStyle(last, span)) {
      last.text += prefix + text;
      last.bounds = unionBounds(last.bounds, span.bounds);
    } else {
      if (prefix && last) last.text += prefix;
      runs.push({ ...span, text, bounds: { ...span.bounds } });
    }
    previous = span;
  }
  const x0 = Math.min(...spans.map((span) => span.bounds.x));
  const x1 = Math.max(...spans.map((span) => span.bounds.x + span.bounds.width));
  return {
    runs,
    text: runs.map((run) => run.text).join(""),
    x0,
    x1,
    top: Math.min(...spans.map((span) => span.bounds.y)),
    bottom: median(spans.map((span) => span.bounds.y + span.bounds.height)),
    size: Math.max(...spans.map((span) => span.fontSizePt)),
  };
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Groups spans by baseline, then splits each line into segments at large horizontal gaps. */
function buildLines(spans: TextSpan[], splitSegments: boolean, wordSpans: boolean): TextLine[] {
  const sorted = [...spans].sort((a, b) => a.bounds.y + a.bounds.height - (b.bounds.y + b.bounds.height) || a.bounds.x - b.bounds.x);
  const groups: { members: TextSpan[]; baseline: number; size: number }[] = [];
  for (const span of sorted) {
    const baseline = span.bounds.y + span.bounds.height;
    let best: (typeof groups)[number] | undefined;
    for (const group of groups) {
      if (Math.abs(group.baseline - baseline) <= 0.4 * Math.min(group.size, span.fontSizePt) && (!best || Math.abs(group.baseline - baseline) < Math.abs(best.baseline - baseline))) best = group;
    }
    if (best) {
      best.members.push(span);
      best.baseline = best.members.reduce((sum, member) => sum + member.bounds.y + member.bounds.height, 0) / best.members.length;
      best.size = Math.max(best.size, span.fontSizePt);
    } else {
      groups.push({ members: [span], baseline, size: span.fontSizePt });
    }
  }

  return groups
    .map((group) => {
      const ordered = [...group.members].sort((a, b) => a.bounds.x - b.bounds.x);
      const threshold = Math.max(2.5 * group.size, 18);
      const parts: TextSpan[][] = [[ordered[0]]];
      for (const span of ordered.slice(1)) {
        const last = parts.at(-1)!.at(-1)!;
        if (splitSegments && span.bounds.x - (last.bounds.x + last.bounds.width) > threshold) parts.push([span]);
        else parts.at(-1)!.push(span);
      }
      // A segment without letters or digits (a stray mark) is not a column; keep it with its neighbour.
      const columns = parts.reduce<TextSpan[][]>((kept, part) => {
        const hasContent = part.some((span) => /[\p{L}\p{N}]/u.test(span.text));
        if (!hasContent && kept.length > 0) kept.at(-1)!.push(...part);
        else kept.push(part);
        return kept;
      }, []);
      if (columns.length > 1 && !columns[0].some((span) => /[\p{L}\p{N}]/u.test(span.text))) columns.splice(0, 2, [...columns[0], ...columns[1]]);
      const segments = columns.map((part) => buildSegment(part, wordSpans));
      return {
        segments,
        x0: Math.min(...segments.map((segment) => segment.x0)),
        x1: Math.max(...segments.map((segment) => segment.x1)),
        top: Math.min(...segments.map((segment) => segment.top)),
        bottom: median(segments.map((segment) => segment.bottom)),
        size: Math.max(...segments.map((segment) => segment.size)),
      };
    })
    .sort((a, b) => a.bottom - b.bottom);
}

// ---------------------------------------------------------------------------
// Paragraphs

const LIST_MARKER = /^(?:[-–•*]\s|\d{1,2}[.)]\s|[a-zđ]\)\s|[IVX]{1,4}\.\s)/i;

type Area = { x0: number; x1: number };

const lineText = (line: TextLine) => line.segments.map((segment) => segment.text).join(" ");
const lineIsBold = (line: TextLine) => line.segments.every((segment) => segment.runs.every((run) => run.bold));

function alignmentOf(lines: TextLine[], area: Area, size: number, allowJustify = true): ParagraphBlock["alignment"] {
  const width = Math.max(1, area.x1 - area.x0);
  const tolerance = Math.max(0.02 * width, 0.75 * size);
  const areaCenter = (area.x0 + area.x1) / 2;
  const centers = lines.map((line) => (line.x0 + line.x1) / 2);
  const leftGap = (line: TextLine) => line.x0 - area.x0;
  const rightGap = (line: TextLine) => area.x1 - line.x1;

  if (lines.length > 1) {
    const spread = Math.max(...centers) - Math.min(...centers);
    const leftSpread = Math.max(...lines.map((line) => line.x0)) - Math.min(...lines.map((line) => line.x0));
    if (spread <= tolerance && leftSpread > tolerance) return "center";
    const rightSpread = Math.max(...lines.map((line) => line.x1)) - Math.min(...lines.map((line) => line.x1));
    if (rightSpread <= tolerance && leftSpread > tolerance && Math.min(...lines.map(leftGap)) > 4 * size) return "right";
    const body = lines.slice(0, -1);
    if (allowJustify && body.every((line) => rightGap(line) <= tolerance)) return "justify";
    return "left";
  }

  const [only] = lines;
  if (leftGap(only) <= tolerance || (leftGap(only) <= size && rightGap(only) <= size)) return "left";
  if (Math.abs(centers[0] - areaCenter) <= tolerance) return "center";
  if (rightGap(only) <= tolerance && leftGap(only) > 4 * size) return "right";
  return "left";
}

/** A line that fills the area is ambiguous (left, justified or centered); others are decisive. */
function lineKind(line: TextLine, area: Area): "center" | "full" | "other" {
  const size = line.size;
  const tolerance = Math.max(0.02 * (area.x1 - area.x0), 0.75 * size);
  if (line.x0 - area.x0 <= size && area.x1 - line.x1 <= size) return "full";
  return Math.abs((line.x0 + line.x1) / 2 - (area.x0 + area.x1) / 2) <= tolerance ? "center" : "other";
}

/** Splits lines into paragraphs and recovers alignment, indentation and spacing. */
function buildParagraphs(lines: TextLine[], area: Area, pitchRatio: number, previousBaseline: number | undefined, allowJustify = true): FlowItem[] {
  if (lines.length === 0) return [];
  const ordered = [...lines].sort((a, b) => a.bottom - b.bottom);
  const groups: TextLine[][] = [[ordered[0]]];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const currentGroup = groups.at(-1)!;
    const size = Math.max(previous.size, current.size);
    const gapRatio = (current.bottom - previous.bottom) / size;
    const areaWidth = Math.max(1, area.x1 - area.x0);
    const tolerance = Math.max(0.02 * areaWidth, 0.75 * size);
    const previousKind = lineKind(previous, area);
    const currentKind = lineKind(current, area);
    // Wrapped centered lines also start further right than the line above; that is not an indent.
    const centerShift = Math.abs((current.x0 + current.x1) / 2 - (previous.x0 + previous.x1) / 2);
    // A short line ends its paragraph only if the first word of the next line would have fitted on it.
    const nextText = lineText(current);
    const nextWordWidth = (nextText.split(" ")[0].length * (current.x1 - current.x0)) / Math.max(1, nextText.length);
    const nextWordFits = previous.x1 + 0.3 * size + nextWordWidth <= area.x1 + 0.5 * tolerance;
    const startsNewParagraph =
      gapRatio > pitchRatio * 1.25 ||
      LIST_MARKER.test(lineText(current)) ||
      (current.x0 - previous.x0 > 0.9 * size && centerShift > tolerance) ||
      (previousKind === "other" && previous.x1 < area.x1 - 0.18 * areaWidth && previous.x0 - area.x0 < areaWidth * 0.5 && nextWordFits) ||
      Math.abs(current.size - previous.size) > 0.2 * size ||
      lineIsBold(current) !== lineIsBold(previous) ||
      (previousKind === "center" && currentKind === "other") ||
      (previousKind === "other" && currentKind === "center");
    if (startsNewParagraph) groups.push([current]);
    else currentGroup.push(current);
  }

  const drafts = groups.map((group) => {
    const size = Math.max(...group.map((line) => line.size));
    return { group, size, alignment: alignmentOf(group, area, size, allowJustify) };
  });

  // A lone full-width line is ambiguous; it follows the centered paragraphs around it.
  const areaWidth = Math.max(1, area.x1 - area.x0);
  for (const draft of drafts) {
    const [only] = draft.group;
    if (draft.group.length !== 1 || lineKind(only, area) !== "full") continue;
    const tolerance = Math.max(0.02 * areaWidth, 0.75 * draft.size);
    const lineCenter = (only.x0 + only.x1) / 2;
    const neighbour = drafts.find((other) => other !== draft && other.alignment === "center" && Math.abs((other.group[0].x0 + other.group[0].x1) / 2 - lineCenter) <= tolerance);
    if (neighbour) draft.alignment = "center";
  }
  const firstLineIndents = drafts.filter((draft) => draft.group.length > 1).map((draft) => draft.group[0].x0 - Math.min(...draft.group.slice(1).map((line) => line.x0)));

  let lastBaseline = previousBaseline;
  return drafts.map(({ group, size, alignment }) => {
    const runs: TextSpan[] = [];
    group.forEach((line, index) => {
      const lineRuns = line.segments.flatMap((segment) => segment.runs);
      if (index > 0) runs.at(-1)!.text += " ";
      runs.push(...lineRuns.map((run) => ({ ...run, bounds: { ...run.bounds } })));
    });
    const first = group[0];
    const restLeft = group.length > 1 ? Math.min(...group.slice(1).map((line) => line.x0)) : first.x0;
    const block: ParagraphBlock = { kind: "paragraph", spans: runs, alignment, lineSpacingPt: round(pitchRatio * size) };
    if (alignment === "left" || alignment === "justify") {
      const leftIndent = group.length > 1 ? restLeft - area.x0 : first.x0 - area.x0;
      const single = group.length === 1;
      // A one-line paragraph indented like the first lines of its neighbours is a first-line indent.
      if (single && leftIndent > 0.9 * size && firstLineIndents.some((indent) => Math.abs(indent - leftIndent) <= 2)) {
        block.firstLineIndentPt = round(leftIndent);
      } else if (leftIndent > 0.9 * size) {
        block.leftIndentPt = round(leftIndent);
      }
      if (!single && first.x0 - restLeft > 0.9 * size) block.firstLineIndentPt = round(first.x0 - restLeft);
    }
    if (lastBaseline !== undefined) {
      const space = first.bottom - lastBaseline - pitchRatio * size;
      if (space > 1) block.spaceBeforePt = round(space);
    }
    lastBaseline = group.at(-1)!.bottom;
    return { top: first.top, bottom: group.at(-1)!.bottom, block };
  });
}

function estimatePitchRatio(lines: TextLine[]): number {
  const ordered = [...lines].sort((a, b) => a.bottom - b.bottom);
  const ratios: number[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (Math.abs(previous.size - current.size) <= 0.2 * current.size) ratios.push((current.bottom - previous.bottom) / current.size);
  }
  if (ratios.length === 0) return 1.25;
  return Math.min(2, Math.max(1.05, percentile(ratios, 0.25)));
}

// ---------------------------------------------------------------------------
// Side-by-side columns

type Slab = { lines: TextLine[]; bands: Interval[]; top: number; bottom: number };

const overlap = (a: Interval, b: Interval) => Math.min(a.to, b.to) - Math.max(a.from, b.from);

function mergeBands(intervals: Interval[], gap: number): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const bands: Interval[] = [];
  for (const interval of sorted) {
    const last = bands.at(-1);
    if (last && interval.from <= last.to + gap) last.to = Math.max(last.to, interval.to);
    else bands.push({ ...interval });
  }
  return bands;
}

function detectSlabs(lines: TextLine[]): Slab[] {
  const slabs: Slab[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = lines[index];
    if (start.segments.length < 2) {
      index++;
      continue;
    }
    const members = [start];
    let bands = mergeBands(start.segments.map((segment) => ({ from: segment.x0, to: segment.x1 })), start.size);
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next];
      const previous = members.at(-1)!;
      if (candidate.top - previous.bottom > 4 * candidate.size) break;
      const intervals = candidate.segments.map((segment) => ({ from: segment.x0, to: segment.x1 }));
      const hits = intervals.map((interval) => bands.filter((band) => overlap(band, interval) > 0));
      const fits = hits.every((hit) => hit.length === 1) && new Set(hits.flat()).size === hits.length;
      if (!fits) break;
      bands = mergeBands([...bands, ...intervals], 0);
      members.push(candidate);
      next++;
    }
    if (bands.length >= 2) {
      slabs.push({ lines: members, bands, top: Math.min(...members.map((line) => line.top)), bottom: Math.max(...members.map((line) => line.bottom)) });
      index = next;
    } else {
      index++;
    }
  }
  return slabs;
}

function partitions(bands: Interval[]): Interval[] {
  return bands.map((band, index) => ({
    from: index === 0 ? band.from : (bands[index - 1].to + band.from) / 2,
    to: index === bands.length - 1 ? band.to : (band.to + bands[index + 1].from) / 2,
  }));
}

/** The alignment most of a column's paragraphs share. */
function cellAlignment(cell: CellBlock[]): "left" | "center" | "right" {
  const paragraphs = cell.filter((item): item is ParagraphBlock => item.kind === "paragraph");
  const count = (alignment: ParagraphBlock["alignment"]) => paragraphs.filter((paragraph) => paragraph.alignment === alignment).length;
  if (paragraphs.length === 0) return "center";
  if (count("center") * 2 >= paragraphs.length) return "center";
  return count("right") * 2 >= paragraphs.length ? "right" : "left";
}

/**
 * Column boxes that keep each column's text where it was: left-aligned text stays at its left edge,
 * centered text around its centre, right-aligned text at its right edge. A little slack stops Word's
 * wider letter shapes from wrapping lines that did not wrap in the source.
 */
function columnBoxes(bands: Interval[], alignments: ("left" | "center" | "right")[]): Interval[] {
  const boxes = bands.map((band, index) => {
    const slack = 0.12 * (band.to - band.from) + 6;
    if (alignments[index] === "center") return { from: band.from - slack / 2, to: band.to + slack / 2 };
    if (alignments[index] === "right") return { from: band.from - slack, to: band.to };
    return { from: band.from, to: band.to + slack };
  });
  // Neighbours share the empty space between their text instead of overlapping.
  for (let index = 0; index < boxes.length - 1; index++) {
    const overlap = boxes[index].to - boxes[index + 1].from;
    if (overlap > 0) {
      boxes[index].to -= overlap / 2;
      boxes[index + 1].from += overlap / 2;
    }
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Page assembly

const SUBSTITUTE_FONT = /times/i;

function cellContent(spans: TextSpan[], images: Image[], area: Box, pitchRatio: number, wordSpans: boolean): CellBlock[] {
  const lines = buildLines(spans, false, wordSpans);
  const items = buildParagraphs(lines, { x0: area.x0, x1: area.x1 }, pitchRatio, undefined, false);
  const imageItems: FlowItem[] = images.map((image) => ({ top: image.bounds.y, bottom: image.bounds.y + image.bounds.height, block: { kind: "image", png: image.png, bounds: image.bounds } }));
  return [...items, ...imageItems].sort((a, b) => a.top - b.top).map((item) => item.block as CellBlock);
}

export function reconstructPage(evidence: PageEvidence): { layout: PageLayout; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const { pageNumber } = evidence;
  const spans = cleanSpans(evidence.spans);
  const images = [...evidence.images];
  const regions = detectTables(evidence.horizontalRules, evidence.verticalRules);
  const items: FlowItem[] = [];

  // Text that sits inside a ruled grid belongs to its cells and is never dropped.
  const regionOf = (x: number, y: number) => regions.find((region) => insideBounds(x, y, regionBounds(region)));
  const flowSpans: TextSpan[] = [];
  const cellSpans = new Map<TableRegion, TextSpan[]>();
  for (const span of spans) {
    const region = regionOf(centerX(span.bounds), centerY(span.bounds));
    if (region) cellSpans.set(region, [...(cellSpans.get(region) ?? []), span]);
    else flowSpans.push(span);
  }
  const flowImages: Image[] = [];
  const cellImages = new Map<TableRegion, Image[]>();
  for (const image of images) {
    const region = regionOf(centerX(image.bounds), centerY(image.bounds));
    if (region) cellImages.set(region, [...(cellImages.get(region) ?? []), image]);
    else flowImages.push(image);
  }

  const wordSpans = evidence.mode === "ocr";
  const flowLines = buildLines(flowSpans, true, wordSpans);
  const pitchRatio = estimatePitchRatio(flowLines);
  const left = flowLines.length ? percentile(flowLines.map((line) => line.x0), 0.1) : 0;
  const right = flowLines.length ? percentile(flowLines.map((line) => line.x1), 0.9) : evidence.widthPt;
  const pageArea: Area = { x0: left, x1: right };

  for (const region of regions) {
    const bounds = regionBounds(region);
    const rows = region.ys.slice(0, -1).map((top, row) => ({
      cells: region.xs.slice(0, -1).map((from, column) => {
        const box: Box = { x0: from, x1: region.xs[column + 1], y0: top, y1: region.ys[row + 1] };
        const inCell = (b: Bounds) => centerX(b) >= box.x0 && centerX(b) < box.x1 && centerY(b) >= box.y0 && centerY(b) < box.y1;
        return cellContent(
          (cellSpans.get(region) ?? []).filter((span) => inCell(span.bounds)),
          (cellImages.get(region) ?? []).filter((image) => inCell(image.bounds)),
          box,
          pitchRatio,
          wordSpans,
        );
      }),
    }));
    const table: TableBlock = {
      kind: "table",
      rows,
      columnWidthsPt: region.xs.slice(1).map((x, index) => round(x - region.xs[index])),
      rowHeightsPt: region.ys.slice(1).map((y, index) => round(y - region.ys[index])),
      bordered: true,
    };
    items.push({ top: bounds.y, bottom: bounds.y + bounds.height, block: table });
    if (!region.complete) {
      warnings.push({
        code: "LAYOUT_APPROXIMATED",
        pageNumber,
        message: "Bảng có ô gộp hoặc đường kẻ không đều nên cấu trúc bảng chỉ được tái tạo gần đúng; nội dung các ô vẫn được giữ.",
      });
    }
  }

  // Side-by-side columns (letterheads, "Nơi nhận" next to the signature) become borderless tables.
  const slabs = detectSlabs(flowLines);
  const slabbed = new Set(slabs.flatMap((slab) => slab.lines));
  const remainingImages = [...flowImages];
  for (const slab of slabs) {
    const parts = partitions(slab.bands);
    const size = Math.max(...slab.lines.map((line) => line.size));
    const claimed = parts.map(() => [] as Image[]);
    for (const image of [...remainingImages]) {
      const index = parts.findIndex((part) => centerX(image.bounds) >= part.from && centerX(image.bounds) < part.to);
      const gap = image.bounds.y - slab.bottom;
      if (index >= 0 && image.bounds.y >= slab.top && gap <= Math.max(60, 5 * size)) {
        claimed[index].push(image);
        remainingImages.splice(remainingImages.indexOf(image), 1);
      }
    }
    const cells = parts.map((part, index) => {
      const bandLines = slab.lines.flatMap((line) => {
        const mine = line.segments.filter((segment) => (segment.x0 + segment.x1) / 2 >= part.from && (segment.x0 + segment.x1) / 2 < part.to);
        return mine.map((segment): TextLine => ({ segments: [segment], x0: segment.x0, x1: segment.x1, top: segment.top, bottom: segment.bottom, size: segment.size }));
      });
      const band = slab.bands[index];
      const content = buildParagraphs(bandLines, { x0: band.from, x1: band.to }, pitchRatio, undefined, false);
      const imageItems: FlowItem[] = claimed[index].map((image) => ({ top: image.bounds.y, bottom: image.bounds.y + image.bounds.height, block: { kind: "image", png: image.png, bounds: image.bounds } }));
      return [...content, ...imageItems].sort((a, b) => a.top - b.top).map((item) => item.block as CellBlock);
    });

    // Each column keeps the place and alignment its text had; the empty space between columns becomes a spacer cell.
    const boxes = columnBoxes(
      slab.bands.map((band, index) => ({
        from: Math.min(band.from, ...claimed[index].map((image) => image.bounds.x)),
        to: Math.max(band.to, ...claimed[index].map((image) => image.bounds.x + image.bounds.width)),
      })),
      cells.map(cellAlignment),
    );
    const rowCells: CellBlock[][] = [];
    const columnWidthsPt: number[] = [];
    boxes.forEach((box, index) => {
      const gap = index > 0 ? box.from - boxes[index - 1].to : 0;
      if (gap > 2) {
        columnWidthsPt.push(round(gap));
        rowCells.push([]);
      }
      columnWidthsPt.push(round(box.to - box.from));
      rowCells.push(cells[index]);
    });
    const bottom = Math.max(slab.bottom, ...claimed.flat().map((image) => image.bounds.y + image.bounds.height));
    items.push({
      top: slab.top,
      bottom,
      block: { kind: "table", rows: [{ cells: rowCells }], columnWidthsPt, xPt: round(boxes[0].from), bordered: false },
    });
  }

  const textLines = flowLines.filter((line) => !slabbed.has(line));
  const textGroups = groupBetween(textLines, items);
  for (const group of textGroups) items.push(...buildParagraphs(group.lines, pageArea, pitchRatio, group.previousBaseline));

  for (const image of remainingImages) {
    items.push({ top: image.bounds.y, bottom: image.bounds.y + image.bounds.height, block: { kind: "image", png: image.png, bounds: image.bounds } satisfies ImageBlock });
  }

  items.sort((a, b) => a.top - b.top);
  const blocks = items.map((item) => item.block);

  const imageCount = blocks.reduce((count, block) => count + countImages(block), 0);
  for (let index = 0; index < imageCount; index++) {
    warnings.push({ code: "RASTER_REGION", pageNumber, message: "Con dấu, chữ ký hoặc hình ảnh được giữ dưới dạng ảnh, không phải chữ có thể chỉnh sửa." });
  }
  if (evidence.mode === "ocr") {
    warnings.push({ code: "OCR_REVIEW", pageNumber, message: "Trang này được nhận dạng chữ (OCR); hãy đối chiếu lại nội dung với bản gốc." });
  } else if (spans.some((span) => span.fontName && !SUBSTITUTE_FONT.test(span.fontName))) {
    warnings.push({ code: "FONT_SUBSTITUTED", pageNumber, message: "Phông chữ gốc được thay bằng Times New Roman nên ngắt dòng và ngắt trang có thể khác bản gốc." });
  }

  return {
    layout: { pageNumber, widthPt: evidence.widthPt, heightPt: evidence.heightPt, blocks, marginsPt: pageMargins(evidence, [...spans.map((span) => span.bounds), ...images.map((image) => image.bounds), ...regions.map(regionBounds)]) },
    warnings,
  };
}

/** Margins that put the first content where it was; the bottom margin only reserves a normal page foot. */
function pageMargins(evidence: PageEvidence, extents: Bounds[]): NonNullable<PageLayout["marginsPt"]> {
  if (extents.length === 0) return { top: 72, right: 72, bottom: 56, left: 72 };
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const left = Math.min(...extents.map((bounds) => bounds.x));
  const right = Math.max(...extents.map((bounds) => bounds.x + bounds.width));
  const top = Math.min(...extents.map((bounds) => bounds.y));
  const bottom = Math.max(...extents.map((bounds) => bounds.y + bounds.height));
  return {
    top: round(clamp(top, 14, 160)),
    left: round(clamp(left, 14, 200)),
    right: round(clamp(evidence.widthPt - right, 14, 200)),
    bottom: round(Math.min(56, Math.max(14, evidence.heightPt - bottom))),
  };
}

function countImages(block: Block): number {
  if (block.kind === "image") return 1;
  if (block.kind === "table") return block.rows.reduce((sum, row) => sum + row.cells.reduce((inner, cell) => inner + cell.filter((item) => item.kind === "image").length, 0), 0);
  return 0;
}

/** Splits the free-flowing lines wherever a table or column block interrupts them, so paragraphs never span one. */
function groupBetween(lines: TextLine[], interrupters: FlowItem[]): { lines: TextLine[]; previousBaseline: number | undefined }[] {
  const groups: { lines: TextLine[]; previousBaseline: number | undefined }[] = [];
  let current: TextLine[] = [];
  let previousBaseline: number | undefined;
  for (const line of lines) {
    const separated = current.length > 0 && interrupters.some((item) => item.top > current.at(-1)!.bottom && item.top < line.top);
    if (separated) {
      groups.push({ lines: current, previousBaseline });
      previousBaseline = undefined;
      current = [];
    }
    if (current.length === 0) {
      const above = interrupters.filter((item) => item.bottom <= line.top).sort((a, b) => b.bottom - a.bottom)[0];
      previousBaseline = above ? above.bottom : undefined;
    }
    current.push(line);
  }
  if (current.length) groups.push({ lines: current, previousBaseline });
  return groups;
}
