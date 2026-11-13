import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx, docxFileName } from "./docx";
import type { Block, CellBlock, ImageBlock, PageLayout, ParagraphBlock, TableBlock } from "./types";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

type Options = Partial<Omit<ParagraphBlock, "kind" | "spans">> & { bold?: boolean; italic?: boolean; size?: number };

const paragraph = (text: string, options: Options = {}): ParagraphBlock => {
  const { bold = false, italic = false, size = 13, alignment = "left", ...rest } = options;
  return {
    kind: "paragraph",
    alignment,
    spans: [{ text, bounds: { x: 0, y: 0, width: 10, height: size }, fontSizePt: size, bold, italic }],
    ...rest,
  };
};

const image = (width = 60, height = 30): ImageBlock => ({ kind: "image", png: PNG, bounds: { x: 100, y: 100, width, height } });
const page = (blocks: Block[], extra: Partial<PageLayout> = {}): PageLayout => ({
  pageNumber: 1,
  widthPt: 595.28,
  heightPt: 841.89,
  blocks,
  marginsPt: { top: 56.7, right: 56.7, bottom: 56.7, left: 85 },
  ...extra,
});
const table = (cells: CellBlock[][], extra: Partial<TableBlock> = {}): TableBlock => ({
  kind: "table",
  rows: [{ cells }],
  columnWidthsPt: cells.map(() => 100),
  bordered: false,
  ...extra,
});

async function open(pages: PageLayout[]) {
  const files = unzipSync(await buildDocx(pages));
  const text = (name: string) => strFromU8(files[name]);
  return { files, document: text("word/document.xml"), text };
}

describe("buildDocx text and formatting", () => {
  it("writes real paragraphs with exact Vietnamese text, alignment, bold, italic and size", async () => {
    const { document } = await open([
      page([
        paragraph("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", { alignment: "center", bold: true, size: 13 }),
        paragraph("Thành phố Mẫu, ngày 12 tháng 11 năm 2026", { alignment: "right", italic: true }),
        paragraph("Thực hiện chỉ đạo của Ủy ban nhân dân thành phố", { alignment: "justify" }),
      ]),
    ]);
    expect(document).toMatch(/<w:t[^>]*>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM<\/w:t>/);
    expect(document).toContain('<w:jc w:val="center"/>');
    expect(document).toContain('<w:jc w:val="right"/>');
    expect(document).toContain('<w:jc w:val="both"/>');
    expect(document).toMatch(/<w:b\/>/);
    expect(document).toMatch(/<w:i\/>/);
    expect(document).toContain('<w:sz w:val="26"/>');
  });

  it("escapes markup characters and keeps leading and trailing spaces", async () => {
    const { document } = await open([page([paragraph("A & B < C > D ", {})])]);
    expect(document).toContain("A &amp; B &lt; C &gt; D ");
    expect(document).toMatch(/<w:t xml:space="preserve">A &amp; B/);
  });

  it("maps indentation and spacing recovered from the page to twips", async () => {
    const { document } = await open([page([paragraph("Đoạn văn", { firstLineIndentPt: 28.5, leftIndentPt: 10, spaceBeforePt: 6, lineSpacingPt: 18 })])]);
    expect(document).toMatch(/<w:ind[^>]*w:firstLine="570"/);
    expect(document).toMatch(/<w:ind[^>]*w:left="200"/);
    expect(document).toMatch(/<w:spacing[^>]*w:before="120"/);
    expect(document).toMatch(/<w:spacing[^>]*w:line="360"[^>]*w:lineRule="exact"/);
  });
});

describe("buildDocx tables and images", () => {
  it("writes a bordered table with real cells, grid widths and borders", async () => {
    const cells = [[paragraph("STT")], [paragraph("Chỉ tiêu")], [paragraph("1.254,7")]];
    const { document } = await open([page([table(cells, { bordered: true, columnWidthsPt: [50, 150, 100], rowHeightsPt: [30] })])]);
    expect(document.match(/<w:tc>/g)).toHaveLength(3);
    expect(document).toContain('<w:gridCol w:w="1000"/>');
    expect(document).toContain('<w:gridCol w:w="3000"/>');
    expect(document).toMatch(/<w:tblBorders>[\s\S]*<w:top w:val="single"/);
    expect(document).toMatch(/<w:trHeight[^>]*w:val="600"/);
    expect(document).toMatch(/<w:t[^>]*>Chỉ tiêu<\/w:t>/);
  });

  it("writes side-by-side columns as a table without borders", async () => {
    const { document } = await open([page([table([[paragraph("Bên trái")], [paragraph("Bên phải")]])])]);
    expect(document).toMatch(/<w:tblBorders>[\s\S]*<w:top w:val="nil"/);
    expect(document.match(/<w:tc>/g)).toHaveLength(2);
  });

  it("indents a table to where its left edge was on the page", async () => {
    const { document } = await open([page([table([[paragraph("Nơi nhận")], [], [paragraph("Ký")]], { xPt: 100 })])]);
    expect(document).toMatch(/<w:tblInd[^>]*w:w="300"/);
  });

  it("keeps a picture inside a cell and a standalone picture, with their sizes", async () => {
    const { document, files } = await open([page([table([[paragraph("Chữ ký"), image(60, 30)], [paragraph("Nơi nhận")]]), image(100, 50)])]);
    expect(document.match(/<w:drawing>/g)).toHaveLength(2);
    expect(document).toContain(`<wp:extent cx="${60 * 12700}" cy="${30 * 12700}"/>`);
    expect(document).toContain(`<wp:extent cx="${100 * 12700}" cy="${50 * 12700}"/>`);
    const media = Object.keys(files).filter((name) => name.startsWith("word/media/"));
    expect(media.length).toBeGreaterThanOrEqual(1);
    expect(Array.from(files[media[0]].slice(0, 4))).toEqual([137, 80, 78, 71]);
  });

  it("gives an empty cell a paragraph and never ends a section on a table", async () => {
    const { document } = await open([page([table([[], [paragraph("Có chữ")]])])]);
    const cellBodies = document.match(/<w:tc>[\s\S]*?<\/w:tc>/g)!;
    for (const body of cellBodies) expect(body).toContain("<w:p");
    expect(document).toMatch(/<\/w:tbl>\s*<w:p[ >/]/);
  });

  it("separates two tables that would otherwise merge in Word", async () => {
    const { document } = await open([page([table([[paragraph("A")]]), table([[paragraph("B")]])])]);
    expect(document).toMatch(/<\/w:tbl>\s*<w:p[ >/][\s\S]*?<w:tbl>/);
  });
});

describe("buildDocx pages and package", () => {
  it("starts every source page in its own section with that page's size and margins", async () => {
    const { document } = await open([
      page([paragraph("Trang một")]),
      page([paragraph("Trang hai")], { pageNumber: 2, widthPt: 841.89, heightPt: 595.28, marginsPt: { top: 36, right: 36, bottom: 36, left: 36 } }),
    ]);
    expect(document.match(/<w:sectPr/g)).toHaveLength(2);
    expect(document).toMatch(/<w:pgSz w:w="11906" w:h="16838"/);
    expect(document).toMatch(/<w:pgSz w:w="16838" w:h="11906"/);
    expect(document).toMatch(/<w:pgMar[^>]*w:left="1700"/);
    expect(document).toMatch(/<w:pgMar[^>]*w:top="720"[^>]*w:right="720"/);
  });

  it("clamps a page larger than Word's 22-inch limit instead of writing an invalid size", async () => {
    const { document } = await open([page([paragraph("Khổ lớn")], { widthPt: 2384, heightPt: 3370 })]);
    expect(document).toMatch(/<w:pgSz w:w="\d+" w:h="31680"/);
    expect(Math.max(...[...document.matchAll(/<w:pgSz w:w="(\d+)" w:h="(\d+)"/g)].flatMap((match) => [Number(match[1]), Number(match[2])]))).toBeLessThanOrEqual(31680);
  });

  it("produces a valid document for a page without content", async () => {
    const { document } = await open([page([])]);
    expect(document).toContain("<w:body>");
    expect(document).toContain("<w:p");
  });

  it("contains no external relationships, macros or invented author metadata", async () => {
    const { files, text } = await open([page([paragraph("Văn bản"), image()])]);
    for (const name of Object.keys(files).filter((file) => file.endsWith(".rels"))) {
      expect(text(name), name).not.toContain("TargetMode");
    }
    expect(Object.keys(files).some((name) => /vba|macro/i.test(name))).toBe(false);
    expect(text("[Content_Types].xml")).not.toMatch(/macroEnabled/i);
    const core = text("docProps/core.xml");
    expect(core).not.toContain("Un-named");
    expect(core).not.toContain("Untitled");
  });
});

describe("docxFileName", () => {
  it("keeps the readable name, drops the directory and extension, and adds .docx", () => {
    expect(docxFileName("Công văn số 125.pdf")).toBe("Công văn số 125.docx");
    expect(docxFileName("C:\\Users\\a\\bao-cao.PDF")).toBe("bao-cao.docx");
    expect(docxFileName("/tmp/x/y/ban-an.pdf")).toBe("ban-an.docx");
  });

  it("removes characters that are unsafe in file names and falls back when nothing is left", () => {
    expect(docxFileName('a<b>:"c|d?*.pdf')).toBe("abcd.docx");
    expect(docxFileName("..pdf")).toBe("tai-lieu.docx");
    expect(docxFileName("")).toBe("tai-lieu.docx");
    expect(docxFileName(`${"x".repeat(200)}.pdf`)).toBe(`${"x".repeat(80)}.docx`);
  });
});
