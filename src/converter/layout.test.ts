import { describe, expect, it } from "vitest";
import { keepTableRules, reconstructPage } from "./layout";
import type { Block, Bounds, CellBlock, PageEvidence, ParagraphBlock, TableBlock, TextSpan } from "./types";

const PAGE_W = 595;
const PAGE_H = 842;
const CHAR_W = 6;

const evidence = (overrides: Partial<PageEvidence> = {}): PageEvidence => ({
  pageNumber: 1,
  widthPt: PAGE_W,
  heightPt: PAGE_H,
  mode: "native",
  spans: [],
  images: [],
  horizontalRules: [],
  verticalRules: [],
  ...overrides,
});

type Style = { size?: number; bold?: boolean; italic?: boolean; fontName?: string };

/** Word spans filling [x0, x1] on a line whose top is `top`; justified unless `ragged`. */
function line(text: string, x0: number, x1: number, top: number, style: Style = {}, ragged = false): TextSpan[] {
  const size = style.size ?? 12;
  const words = text.split(" ");
  const widths = words.map((word) => Array.from(word).length * CHAR_W);
  const gap = ragged || words.length === 1 ? size * 0.3 : (x1 - x0 - widths.reduce((a, b) => a + b, 0)) / (words.length - 1);
  let x = x0;
  return words.map((word, index) => {
    const span: TextSpan = {
      text: word,
      bounds: { x, y: top, width: widths[index], height: size },
      fontSizePt: size,
      bold: style.bold ?? false,
      italic: style.italic ?? false,
      fontName: style.fontName,
    };
    x += widths[index] + gap;
    return span;
  });
}

const rule = (x: number, y: number, width: number, height: number): Bounds => ({ x, y, width, height });
const hRule = (y: number, x0: number, x1: number) => rule(x0, y - 0.5, x1 - x0, 1);
const vRule = (x: number, y0: number, y1: number) => rule(x - 0.5, y0, 1, y1 - y0);

const shuffled = <T,>(items: T[]): T[] => [...items].sort((a, b) => ((JSON.stringify(a).length * 7) % 5) - ((JSON.stringify(b).length * 11) % 5));

const textOf = (paragraph: ParagraphBlock) => paragraph.spans.map((span) => span.text).join("");
const paragraphs = (blocks: Block[]) => blocks.filter((block): block is ParagraphBlock => block.kind === "paragraph");
const tables = (blocks: Block[]) => blocks.filter((block): block is TableBlock => block.kind === "table");
const cellText = (cell: CellBlock[]) =>
  cell.filter((block): block is ParagraphBlock => block.kind === "paragraph").map(textOf);

describe("reading order, alignment and text", () => {
  const heading = line("KẾ HOẠCH CÔNG TÁC", 197, 397, 60, { size: 16, bold: true });
  const body = [
    ...line("Căn cứ chỉ đạo của Ủy ban nhân dân thành phố về việc triển khai", 96, 523, 100),
    ...line("nhiệm vụ trọng tâm của quý bốn năm hai nghìn không trăm hai mươi sáu", 72, 523, 117),
    ...line("Trân trọng cảm ơn./.", 72, 200, 134, {}, true),
  ];

  it("restores reading order from shuffled spans and keeps Vietnamese text exact", () => {
    const { layout } = reconstructPage(evidence({ spans: shuffled([...body, ...heading]) }));
    const [first, second] = paragraphs(layout.blocks);
    expect(textOf(first)).toBe("KẾ HOẠCH CÔNG TÁC");
    expect(textOf(second)).toBe(
      "Căn cứ chỉ đạo của Ủy ban nhân dân thành phố về việc triển khai nhiệm vụ trọng tâm của quý bốn năm hai nghìn không trăm hai mươi sáu Trân trọng cảm ơn./.",
    );
    expect(textOf(first)).toBe(textOf(first).normalize("NFC"));
  });

  it("keeps a centered heading centered and justifies a wrapped body", () => {
    const { layout } = reconstructPage(evidence({ spans: shuffled([...body, ...heading]) }));
    const [first, second] = paragraphs(layout.blocks);
    expect(first.alignment).toBe("center");
    expect(second.alignment).toBe("justify");
    expect(second.firstLineIndentPt).toBeGreaterThan(20);
  });

  it("starts a new paragraph at each list marker", () => {
    const spans = [
      ...line("- Như trên;", 72, 160, 100, {}, true),
      ...line("- Lưu: VT, VP.", 72, 190, 117, {}, true),
      ...line("1. Báo cáo kết quả thực hiện", 72, 280, 134, {}, true),
    ];
    const { layout } = reconstructPage(evidence({ spans }));
    expect(paragraphs(layout.blocks).map(textOf)).toEqual(["- Như trên;", "- Lưu: VT, VP.", "1. Báo cáo kết quả thực hiện"]);
  });

  it("right-aligns text that sits flush with the right margin", () => {
    const spans = [
      ...line("Thành phố Mẫu, ngày 12 tháng 11", 72, 523, 100),
      ...line("năm 2026", 72, 400, 117, {}, true),
      ...line("Thành phố Mẫu, ngày 12", 380, 523, 160, { italic: true }, true),
    ];
    const { layout } = reconstructPage(evidence({ spans }));
    expect(paragraphs(layout.blocks).at(-1)!.alignment).toBe("right");
  });

  it("does not emit text twice when hidden OCR text overlaps a native layer", () => {
    const native = line("Kính gửi: Các sở, ban, ngành", 72, 300, 100, {}, true);
    const duplicate = native.map((span) => ({ ...span, bounds: { ...span.bounds, x: span.bounds.x + 0.8, y: span.bounds.y + 0.5 } }));
    const { layout } = reconstructPage(evidence({ spans: [...native, ...duplicate] }));
    expect(paragraphs(layout.blocks).map(textOf)).toEqual(["Kính gửi: Các sở, ban, ngành"]);
  });

  it("does not turn an isolated punctuation mark into a column", () => {
    const spans = [...line("Rất mong nhận được sự phối hợp của Quý cơ quan", 72, 400, 100, {}, true), ...line(":", 500, 506, 100)];
    const { layout } = reconstructPage(evidence({ spans }));
    expect(layout.blocks.map((block) => block.kind)).toEqual(["paragraph"]);
    expect(textOf(paragraphs(layout.blocks)[0])).toContain(":");
  });

  it("reports the page margins implied by the content, with a sane bottom margin", () => {
    const spans = [...line("Dòng đầu tiên của văn bản", 72, 523, 60), ...line("Dòng thứ hai của văn bản", 72, 523, 77, {}, true)];
    const { marginsPt } = reconstructPage(evidence({ spans })).layout;
    expect(marginsPt).toEqual({ top: 60, left: 72, right: 72, bottom: 56 });
  });

  it("produces an empty page for empty evidence", () => {
    expect(reconstructPage(evidence()).layout.blocks).toEqual([]);
  });

  it("separates OCR words that touch, but joins native runs that touch", () => {
    const touching = [
      { text: "Thành", bounds: { x: 72, y: 100, width: 30, height: 12 }, fontSizePt: 12, bold: false, italic: false },
      { text: "phố", bounds: { x: 102, y: 100, width: 18, height: 12 }, fontSizePt: 12, bold: false, italic: false },
    ];
    expect(textOf(paragraphs(reconstructPage(evidence({ spans: touching, mode: "ocr" })).layout.blocks)[0])).toBe("Thành phố");
    expect(textOf(paragraphs(reconstructPage(evidence({ spans: touching })).layout.blocks)[0])).toBe("Thànhphố");
  });
});

describe("ruled tables", () => {
  const xs = [72, 222, 372, 472];
  const ys = [200, 230, 260];
  const rules = {
    horizontalRules: ys.map((y) => hRule(y, 72, 472)),
    verticalRules: xs.map((x) => vRule(x, 200, 260)),
  };
  const cells = [
    ["STT", "Chỉ tiêu", "Kết quả"],
    ["1", "Tổng thu ngân sách", "1.254,7"],
  ];
  const cellSpans = cells.flatMap((row, r) => row.flatMap((text, c) => line(text, xs[c] + 6, xs[c] + 6 + text.length * CHAR_W, ys[r] + 9, {}, true)));

  it("builds a bordered table with the authored rows and cells, whatever the span order", () => {
    const { layout } = reconstructPage(evidence({ spans: shuffled(cellSpans), ...rules }));
    const [table] = tables(layout.blocks);
    expect(table.bordered).toBe(true);
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((row) => row.cells.length)).toEqual([3, 3]);
    expect(table.rows.map((row) => row.cells.map((cell) => cellText(cell).join(" ")))).toEqual(cells);
    expect(table.columnWidthsPt).toEqual([150, 150, 100]);
    expect(table.rowHeightsPt).toEqual([30, 30]);
  });

  it("keeps several paragraphs inside one cell", () => {
    const tall = { horizontalRules: [hRule(200, 72, 472), hRule(230, 72, 472), hRule(300, 72, 472)], verticalRules: xs.map((x) => vRule(x, 200, 300)) };
    const spans = [
      ...line("STT", 78, 96, 209, {}, true),
      ...line("Dòng một", xs[1] + 6, xs[1] + 70, 236, {}, true),
      ...line("Dòng hai", xs[1] + 6, xs[1] + 70, 268, {}, true),
    ];
    const { layout } = reconstructPage(evidence({ spans, ...tall }));
    const secondRow = tables(layout.blocks)[0].rows[1];
    expect(cellText(secondRow.cells[1])).toEqual(["Dòng một", "Dòng hai"]);
  });

  it("flags an irregular grid but never drops a word", () => {
    const merged = {
      horizontalRules: ys.map((y) => hRule(y, 72, 472)),
      verticalRules: [vRule(72, 200, 260), vRule(222, 200, 260), vRule(372, 200, 230), vRule(472, 200, 260)],
    };
    const { layout, warnings } = reconstructPage(evidence({ spans: cellSpans, ...merged }));
    expect(warnings.map((warning) => warning.code)).toContain("LAYOUT_APPROXIMATED");
    const [table] = tables(layout.blocks);
    const emitted = table.rows.flatMap((row) => row.cells.flatMap(cellText)).join(" ");
    for (const word of ["STT", "Chỉ", "tiêu", "Kết", "quả", "Tổng", "thu", "ngân", "sách", "1.254,7"]) {
      expect(emitted).toContain(word);
    }
  });

  it("joins wrapped cell lines only when the next word could not have fitted", () => {
    const wrapped = [...line("Doanh nghiệp", 378, 448, 233, {}, true), ...line("thành lập", 378, 430, 248, {}, true)];
    const short = [...line("Doanh", 378, 408, 233, {}, true), ...line("thành lập", 378, 430, 248, {}, true)];
    const cellOf = (spans: TextSpan[]) => cellText(tables(reconstructPage(evidence({ spans, ...rules })).layout.blocks)[0].rows[1].cells[2]);
    expect(cellOf(wrapped)).toEqual(["Doanh nghiệp thành lập"]);
    expect(cellOf(short)).toEqual(["Doanh", "thành lập"]);
  });

  it("leaves text outside the table in the page flow", () => {
    const caption = line("Bảng tổng hợp chỉ tiêu", 72, 260, 150, {}, true);
    const { layout } = reconstructPage(evidence({ spans: [...caption, ...cellSpans], ...rules }));
    expect(layout.blocks.map((block) => block.kind)).toEqual(["paragraph", "table"]);
  });
});

describe("keepTableRules", () => {
  it("keeps the rules of a ruled grid and drops stray long strokes", () => {
    const grid = {
      horizontal: [hRule(200, 72, 472), hRule(230, 72, 472), hRule(260, 72, 472)],
      vertical: [72, 222, 372, 472].map((x) => vRule(x, 200, 260)),
    };
    const stray = hRule(500, 100, 130);
    const kept = keepTableRules([...grid.horizontal, stray], grid.vertical);
    expect(kept.horizontal).toHaveLength(3);
    expect(kept.vertical).toHaveLength(4);
  });

  it("drops rules that never form a grid", () => {
    expect(keepTableRules([hRule(100, 50, 300), hRule(140, 50, 300)], [])).toEqual({ horizontal: [], vertical: [] });
  });
});

describe("side-by-side columns", () => {
  const centered = (text: string, center: number, top: number, style: Style = {}) => {
    const words = text.split(" ");
    const width = words.reduce((sum, word) => sum + Array.from(word).length * CHAR_W, 0) + (words.length - 1) * 12 * 0.3;
    return line(text, center - width / 2, center + width / 2, top, style, true);
  };
  const left = [...centered("ỦY BAN NHÂN DÂN", 132, 40), ...centered("SỞ KẾ HOẠCH", 132, 57, { bold: true })];
  const right = [...centered("CỘNG HÒA XÃ HỘI", 430, 40, { bold: true }), ...centered("Độc lập - Tự do - Hạnh phúc", 430, 57, { bold: true })];
  const body = line("Kính gửi: Các sở, ban, ngành", 72, 523, 120, {}, true);
  const columnsEnd = Math.max(...[...left, ...right].map((span) => span.bounds.x + span.bounds.width));
  const columnsStart = Math.min(...[...left, ...right].map((span) => span.bounds.x));

  it("turns a two-column letterhead into a borderless table and keeps later text outside it", () => {
    const { layout } = reconstructPage(evidence({ spans: shuffled([...left, ...right, ...body]) }));
    const [table] = tables(layout.blocks);
    expect(table.bordered).toBe(false);
    expect(table.rows).toHaveLength(1);
    // Left text, an empty spacer for the gap, right text.
    expect(table.rows[0].cells.map(cellText)).toEqual([
      ["ỦY BAN NHÂN DÂN", "SỞ KẾ HOẠCH"],
      [],
      ["CỘNG HÒA XÃ HỘI Độc lập - Tự do - Hạnh phúc"],
    ]);
    expect(layout.blocks.map((block) => block.kind)).toEqual(["table", "paragraph"]);
    expect(table.xPt!).toBeLessThanOrEqual(columnsStart);
    expect(table.xPt! + table.columnWidthsPt.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(columnsEnd);
  });

  it("centers each cell's text inside its own column", () => {
    const { layout } = reconstructPage(evidence({ spans: [...left, ...right, ...body] }));
    const rightCell = tables(layout.blocks)[0].rows[0].cells[2];
    expect((rightCell[0] as ParagraphBlock).alignment).toBe("center");
  });
});

describe("artwork and warnings", () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const left = [...line("Nơi nhận:", 72, 130, 400, {}, true), ...line("- Lưu: VT, VP.", 72, 160, 417, {}, true)];
  const right = [...line("GIÁM ĐỐC", 400, 470, 400, { bold: true }), ...line("Nguyễn Văn Mẫu", 380, 490, 424, { bold: true })];

  it("keeps a signature block on the right, with its centered text centered on the same spot", () => {
    const { layout } = reconstructPage(evidence({ spans: [...left, ...right] }));
    const [table] = tables(layout.blocks);
    const [leftWidth, gap, rightWidth] = table.columnWidthsPt;
    expect(table.xPt).toBe(72);
    expect(gap).toBeGreaterThan(150);
    const rightStart = table.xPt! + leftWidth + gap;
    expect(rightStart + rightWidth / 2).toBeCloseTo(435, 0);
  });

  it("places a stamp under the signature inside its column and flags the raster region", () => {
    const stamp = { bounds: { x: 405, y: 440, width: 60, height: 60 }, png };
    const { layout, warnings } = reconstructPage(evidence({ spans: [...left, ...right], images: [stamp] }));
    const [table] = tables(layout.blocks);
    expect(table.rows[0].cells[2].map((block) => block.kind)).toEqual(["paragraph", "paragraph", "image"]);
    expect(warnings.filter((warning) => warning.code === "RASTER_REGION")).toHaveLength(1);
  });

  it("keeps a standalone image in reading order between paragraphs", () => {
    const spans = [...line("Đoạn đầu tiên của văn bản", 72, 400, 100, {}, true), ...line("Đoạn cuối cùng của văn bản", 72, 400, 300, {}, true)];
    const { layout } = reconstructPage(evidence({ spans, images: [{ bounds: { x: 200, y: 160, width: 100, height: 80 }, png }] }));
    expect(layout.blocks.map((block) => block.kind)).toEqual(["paragraph", "image", "paragraph"]);
  });

  it("asks for review of OCR pages and flags substituted fonts on native pages", () => {
    const spans = line("Văn bản mẫu", 72, 200, 100, { fontName: "AAAAAA+NotoSerif-Regular" }, true);
    expect(reconstructPage(evidence({ spans })).warnings.map((warning) => warning.code)).toEqual(["FONT_SUBSTITUTED"]);
    expect(reconstructPage(evidence({ spans, mode: "ocr" })).warnings.map((warning) => warning.code)).toEqual(["OCR_REVIEW"]);
    const times = line("Văn bản mẫu", 72, 200, 100, { fontName: "BCDEEE+TimesNewRomanPSMT" }, true);
    expect(reconstructPage(evidence({ spans: times })).warnings).toEqual([]);
  });
});
