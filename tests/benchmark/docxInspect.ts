import { strFromU8, unzipSync } from "fflate";

export type InspectedSection = {
  text: string;
  tables: number;
  /** Tables drawn with borders, i.e. real ruled tables rather than side-by-side columns. */
  borderedTables: number;
  /** Bordered tables that hold text. */
  editableTables: number;
  cells: number;
  /** Cells of bordered tables with neither text nor a picture. */
  emptyBorderedCells: number;
  pictures: number;
  /** Picture area as a share of the page area. */
  pictureShare: number;
};

const unescapeXml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const textRuns = (xml: string) => (xml.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((run) => unescapeXml(run.replace(/<[^>]+>/g, "")));

/** Reads a DOCX the way its reader would: one entry per Word section, i.e. per source page. */
export function inspectDocx(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const xml = strFromU8(files["word/document.xml"]);
  const pageSizes = [...xml.matchAll(/<w:pgSz w:w="(\d+)" w:h="(\d+)"/g)].map((match) => Number(match[1]) * Number(match[2]) * 635 * 635);
  const body = xml.slice(xml.indexOf("<w:body>"), xml.lastIndexOf("<w:sectPr"));

  // A section ends with the paragraph that carries its sectPr; the last section ends at the body.
  const chunks: string[] = [];
  let start = 0;
  for (const paragraph of body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    if (!paragraph[0].includes("<w:sectPr")) continue;
    const end = paragraph.index + paragraph[0].length;
    chunks.push(body.slice(start, end));
    start = end;
  }
  chunks.push(body.slice(start));

  const sections: InspectedSection[] = chunks.map((chunk, index) => {
    const paragraphs = chunk.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
    const bordered = (chunk.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []).filter((table) => /<w:top w:val="single"/.test(table));
    const cellsOf = (table: string) => table.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? [];
    const filled = (cell: string) => textRuns(cell).join("").trim().length > 0 || cell.includes("<w:drawing>");
    const pictureArea = [...chunk.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].reduce((sum, match) => sum + Number(match[1]) * Number(match[2]), 0);
    return {
      text: paragraphs.map((paragraph) => textRuns(paragraph).join("")).filter(Boolean).join("\n"),
      tables: (chunk.match(/<w:tbl>/g) ?? []).length,
      borderedTables: bordered.length,
      editableTables: bordered.filter((table) => cellsOf(table).some((cell) => textRuns(cell).join("").trim())).length,
      cells: (chunk.match(/<w:tc>/g) ?? []).length,
      emptyBorderedCells: bordered.reduce((sum, table) => sum + cellsOf(table).filter((cell) => !filled(cell)).length, 0),
      pictures: (chunk.match(/<w:drawing>/g) ?? []).length,
      pictureShare: pageSizes[index] ? pictureArea / pageSizes[index] : 0,
    };
  });
  return { files, xml, sections };
}
