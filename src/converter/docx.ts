import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  ImageRun,
  LineRuleType,
  PageOrientation,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type ISectionOptions,
} from "docx";
import type { Block, CellBlock, ImageBlock, PageLayout, ParagraphBlock, TableBlock } from "./types";

// Official Vietnamese documents are set in Times New Roman, which every Word install has.
const FONT = "Times New Roman";
const WORD_MAX_PAGE_PT = 1584;
const twips = (pt: number) => Math.round(pt * 20);
const pixels = (pt: number) => (pt * 96) / 72;

const ALIGNMENT: Record<ParagraphBlock["alignment"], (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.BOTH,
};

function paragraphOf(block: ParagraphBlock): Paragraph {
  return new Paragraph({
    alignment: ALIGNMENT[block.alignment],
    indent: {
      ...(block.leftIndentPt ? { left: twips(block.leftIndentPt) } : {}),
      ...(block.firstLineIndentPt ? { firstLine: twips(block.firstLineIndentPt) } : {}),
    },
    spacing: {
      before: twips(block.spaceBeforePt ?? 0),
      after: 0,
      ...(block.lineSpacingPt ? { line: twips(block.lineSpacingPt), lineRule: LineRuleType.EXACT } : {}),
    },
    children: block.spans.map(
      (span) => new TextRun({ text: span.text, bold: span.bold || undefined, italics: span.italic || undefined, size: Math.round(span.fontSizePt * 2), font: FONT }),
    ),
  });
}

function imageRun(image: ImageBlock): ImageRun {
  return new ImageRun({
    type: "png",
    data: image.png,
    transformation: { width: pixels(image.bounds.width), height: pixels(image.bounds.height) },
    altText: { name: "Hình ảnh", description: "Con dấu, chữ ký hoặc hình ảnh từ bản gốc", title: "Hình ảnh" },
  });
}

function imageParagraph(image: ImageBlock, layout?: PageLayout): Paragraph {
  let alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.CENTER;
  let indent: number | undefined;
  if (layout) {
    const margins = layout.marginsPt ?? { left: 72, right: 72, top: 72, bottom: 56 };
    const center = image.bounds.x + image.bounds.width / 2;
    if (Math.abs(center - layout.widthPt / 2) > 0.05 * layout.widthPt) {
      if (image.bounds.x + image.bounds.width >= layout.widthPt - margins.right - 12) alignment = AlignmentType.RIGHT;
      else {
        alignment = AlignmentType.LEFT;
        indent = Math.max(0, image.bounds.x - margins.left);
      }
    }
  }
  return new Paragraph({
    alignment,
    indent: indent && indent > 4 ? { left: twips(indent) } : undefined,
    spacing: { before: 0, after: 0 },
    children: [imageRun(image)],
  });
}

// An empty one-point line keeps Word from merging neighbouring tables and ends a section after a table.
const spacer = () =>
  new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [new TextRun({ text: "", size: 2 })] });

function cellChildren(cell: CellBlock[]): Paragraph[] {
  const children = cell.map((item) => (item.kind === "image" ? imageParagraph(item) : paragraphOf(item)));
  return children.length ? children : [new Paragraph({})];
}

function tableOf(block: TableBlock, marginLeftPt: number): Table {
  const line = block.bordered ? { style: BorderStyle.SINGLE, size: 4, color: "000000" } : { style: BorderStyle.NIL, size: 0, color: "auto" };
  const widths = block.columnWidthsPt.map(twips);
  return new Table({
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    ...(block.xPt !== undefined && Math.abs(block.xPt - marginLeftPt) > 2
      ? { indent: { size: twips(block.xPt - marginLeftPt), type: WidthType.DXA } }
      : {}),
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
    rows: block.rows.map(
      (row, rowIndex) =>
        new TableRow({
          cantSplit: true,
          ...(block.rowHeightsPt?.[rowIndex] ? { height: { value: twips(block.rowHeightsPt[rowIndex]), rule: HeightRule.ATLEAST } } : {}),
          children: row.cells.map(
            (cell, columnIndex) =>
              new TableCell({
                width: { size: widths[columnIndex] ?? 0, type: WidthType.DXA },
                margins: block.bordered ? { top: 40, bottom: 40, left: 80, right: 80 } : { top: 0, bottom: 0, left: 0, right: 0 },
                verticalAlign: block.bordered ? VerticalAlign.CENTER : VerticalAlign.TOP,
                children: cellChildren(cell),
              }),
          ),
        }),
    ),
  });
}

function sectionOf(layout: PageLayout): ISectionOptions {
  const children: (Paragraph | Table)[] = [];
  const append = (block: Block) => {
    if (block.kind === "table") {
      if (children.at(-1) instanceof Table) children.push(spacer());
      children.push(tableOf(block, (layout.marginsPt ?? { left: 72 }).left));
    } else if (block.kind === "image") {
      children.push(imageParagraph(block, layout));
    } else {
      children.push(paragraphOf(block));
    }
  };
  layout.blocks.forEach(append);
  if (children.length === 0 || children.at(-1) instanceof Table) children.push(spacer());

  const margins = layout.marginsPt ?? { top: 72, right: 72, bottom: 56, left: 72 };
  const landscape = layout.widthPt > layout.heightPt;
  // Word cannot open pages larger than 22 inches; such a page is shrunk to fit (its content is not scaled).
  const fit = Math.min(1, WORD_MAX_PAGE_PT / Math.max(layout.widthPt, layout.heightPt));
  return {
    properties: {
      page: {
        size: {
          width: twips(Math.min(layout.widthPt, layout.heightPt) * fit),
          height: twips(Math.max(layout.widthPt, layout.heightPt) * fit),
          orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
        },
        margin: { top: twips(margins.top * fit), right: twips(margins.right * fit), bottom: twips(margins.bottom * fit), left: twips(margins.left * fit) },
      },
    },
    children,
  };
}

/** One Word section per source page, so page breaks and page sizes follow the original. */
export async function buildDocx(pages: PageLayout[]): Promise<Uint8Array> {
  const document = new Document({
    creator: " ",
    lastModifiedBy: " ",
    title: " ",
    description: " ",
    sections: pages.length ? pages.map(sectionOf) : [{ children: [spacer()] }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}

/** A safe local file name for the download: the source name without directory or extension, plus .docx. */
export function docxFileName(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.pdf$/i, "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  return `${stem || "tai-lieu"}.docx`;
}
