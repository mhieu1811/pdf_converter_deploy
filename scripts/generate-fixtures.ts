import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { PDFDocument, PDFHexString, StandardFonts, degrees } from "pdf-lib";
import { FIXTURES } from "../tests/fixtures/manifest";
import {
  BAD_LAYER_NATIVE_PAGE2,
  BAD_LAYER_SCANNED,
  MIXED_HEADING,
  MIXED_NATIVE_PAGE2,
  MIXED_SCANNED_BODY,
  congvan,
  diacritics,
  listPlan,
  longDocument,
  tableLetter,
  type DocBlock,
  type Line,
  type TemplatePage,
} from "../tests/fixtures/templates";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".test-artifacts", "fixtures");
const fontDir = path.join(root, "tests", "fixtures", "assets", "fonts");

const A4_W = 595.28;
const A4_H = 841.89;
const TEN_MIB = 10 * 1024 * 1024;

const RANGES: Record<string, string> = {
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  "latin-ext": "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
  vietnamese: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
};

async function fontCss(): Promise<string> {
  const faces: string[] = [];
  for (const subset of ["latin", "latin-ext", "vietnamese"]) {
    for (const weight of [400, 700]) {
      for (const style of ["normal", "italic"]) {
        const file = path.join(fontDir, `noto-serif-${subset}-${weight}-${style}.woff2`);
        const data = (await readFile(file)).toString("base64");
        faces.push(
          `@font-face{font-family:'Noto Serif';font-style:${style};font-weight:${weight};font-display:block;` +
            `src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${RANGES[subset]};}`,
        );
      }
    }
  }
  return faces.join("\n");
}

const PAGE_CSS = `
@page{size:210mm 297mm;margin:0}
html,body{margin:0;padding:0;background:#fff}
body{font-family:'Noto Serif',serif;font-size:13pt;line-height:1.4;color:#000}
.page{width:210mm;height:297mm;box-sizing:border-box;padding:18mm 15mm 18mm 25mm;overflow:hidden;break-after:page;position:relative;background:#fff}
.page:last-child{break-after:auto}
p{margin:0 0 6pt 0}
.cols{display:flex;gap:6mm;margin-bottom:8pt}
.cols .r{flex:1}
table{border-collapse:collapse;width:100%;margin:8pt 0 10pt}
td,th{border:1px solid #000;padding:4pt 6pt;text-align:left}
th{font-weight:700}
.stamp{display:block;width:26mm;margin:2mm auto 0}
img.body{display:block;width:170mm}
.abs-img{position:absolute;left:0;top:0;width:210mm;height:297mm}
.hidden-layer{position:absolute;left:25mm;top:20mm;width:160mm;font-size:9pt;opacity:0.01}
`;

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function lineHtml(line: Line): string {
  const style = [
    line.align ? `text-align:${line.align}` : "",
    line.bold ? "font-weight:700" : "",
    line.italic ? "font-style:italic" : "",
    line.indent ? "text-indent:10mm" : "",
  ]
    .filter(Boolean)
    .join(";");
  return `<p style="${style}">${esc(line.text)}</p>`;
}

function blockHtml(block: DocBlock, stampUrl: string): string {
  if (block.kind === "paragraphs") return block.lines.map(lineHtml).join("");
  if (block.kind === "columns") {
    const left = block.leftWidthPct ?? 42;
    const stamp = block.artwork ? `<img class="stamp" alt="" src="${stampUrl}">` : "";
    return `<div class="cols"><div style="width:${left}%">${block.left.map(lineHtml).join("")}</div><div class="r">${block.right.map(lineHtml).join("")}${stamp}</div></div>`;
  }
  const cols = block.widthsPct.map((width) => `<col style="width:${width}%">`).join("");
  const head = `<tr>${block.header.map((cell) => `<th>${esc(cell)}</th>`).join("")}</tr>`;
  const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("");
  return `<table><colgroup>${cols}</colgroup>${head}${rows}</table>`;
}

const pageHtml = (inner: string) => `<section class="page">${inner}</section>`;
const templateHtml = (pages: TemplatePage[], stampUrl: string) =>
  pages.map((page) => pageHtml(page.blocks.map((block) => blockHtml(block, stampUrl)).join(""))).join("");

class Renderer {
  private constructor(
    readonly page: Page,
    private readonly css: string,
    private stampUrl = "",
  ) {}

  static async create(page: Page): Promise<Renderer> {
    const renderer = new Renderer(page, await fontCss());
    renderer.stampUrl = await page.evaluate(drawStamp);
    return renderer;
  }

  get stamp() {
    return this.stampUrl;
  }

  async load(bodyHtml: string): Promise<void> {
    await this.page.setContent(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${this.css}${PAGE_CSS}</style></head><body>${bodyHtml}</body></html>`);
    await this.page.evaluate("globalThis.__name ??= (fn) => fn");
    await this.page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    const overflow = await this.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".page")].map((element) => element.scrollHeight > element.clientHeight + 1),
    );
    if (overflow.some(Boolean)) throw new Error(`Authored content overflows an A4 page: ${overflow.join(",")}`);
  }

  async pdf(bodyHtml: string): Promise<Uint8Array> {
    await this.load(bodyHtml);
    return new Uint8Array(await this.page.pdf({ preferCSSPageSize: true, printBackground: true }));
  }

  async screenshotPages(bodyHtml: string): Promise<Buffer[]> {
    await this.load(bodyHtml);
    const count = await this.page.locator(".page").count();
    const shots: Buffer[] = [];
    for (let index = 0; index < count; index++) shots.push(await this.page.locator(".page").nth(index).screenshot());
    return shots;
  }

  async screenshotBody(bodyHtml: string): Promise<Buffer> {
    await this.load(`<div class="page" style="height:auto;padding:0;width:170mm">${bodyHtml}</div>`);
    return this.page.locator(".page").screenshot();
  }
}

// Runs in the browser: a red circular seal with a blue scribbled signature.
function drawStamp(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 300, 300);
  ctx.strokeStyle = "#d0201f";
  ctx.fillStyle = "#d0201f";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(150, 150, 130, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(150, 150, 108, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = "bold 54px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("MẪU", 150, 140);
  ctx.font = "bold 24px sans-serif";
  ctx.fillText("KHÔNG CÓ GIÁ TRỊ", 150, 180);
  ctx.strokeStyle = "#1c3fa8";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(70, 210);
  ctx.bezierCurveTo(110, 120, 150, 260, 180, 150);
  ctx.bezierCurveTo(200, 100, 230, 200, 250, 110);
  ctx.stroke();
  return canvas.toDataURL("image/png");
}

type Degrade = { skewDeg: number; noise: number; specks: number; seed: number };

// Runs in the browser. Seeded so the fixture bytes are reproducible.
async function degradeInBrowser(args: { dataUrl: string; options: Degrade }): Promise<string> {
  const { dataUrl, options } = args;
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((options.skewDeg * Math.PI) / 180);
  ctx.drawImage(image, -image.width / 2, -image.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  let state = options.seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const gaussian = Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());
    const delta = gaussian * options.noise;
    for (let channel = 0; channel < 3; channel++) {
      data.data[i + channel] = Math.max(0, Math.min(255, data.data[i + channel] * 0.96 + delta));
    }
  }
  ctx.putImageData(data, 0, 0);
  ctx.fillStyle = "rgba(60,60,60,0.7)";
  for (let i = 0; i < options.specks; i++) {
    ctx.beginPath();
    ctx.arc(random() * canvas.width, random() * canvas.height, 1 + random() * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toDataURL("image/png");
}

async function rotateCounterClockwise(page: Page, png: Buffer): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.height;
    canvas.height = image.width;
    const ctx = canvas.getContext("2d")!;
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  }, `data:image/png;base64,${png.toString("base64")}`);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

const toBuffer = (dataUrl: string) => Buffer.from(dataUrl.split(",")[1], "base64");

async function imagesToPdf(pngs: Buffer[], sideways = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const png of pngs) {
    const [width, height] = sideways ? [A4_H, A4_W] : [A4_W, A4_H];
    const page = doc.addPage([width, height]);
    page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width, height });
    if (sideways) page.setRotation(degrees(90));
  }
  return doc.save();
}

async function textPdf(pageTexts: string[], size: [number, number] = [A4_W, A4_H]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage(size);
    if (text) page.drawText(text, { x: 72, y: size[1] - 100, size: Math.max(14, size[0] / 40), font });
  }
  return doc.save();
}

async function paddedPdf(targetBytes: number): Promise<Uint8Array> {
  let payload = targetBytes - 2500;
  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([A4_W, A4_H]).drawText("Trang 1", { x: 72, y: 700, size: 18, font });
    const filler = new Uint8Array(payload);
    for (let i = 0; i < filler.length; i++) filler[i] = (i * 31 + 7) % 251;
    doc.context.register(doc.context.stream(filler));
    const bytes = await doc.save({ useObjectStreams: false });
    if (bytes.length === targetBytes) return bytes;
    payload += targetBytes - bytes.length;
  }
  throw new Error(`Could not size the padded PDF to exactly ${targetBytes} bytes`);
}

async function protectedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([A4_W, A4_H]).drawText("Protected", { x: 72, y: 700, size: 18, font });
  const hex = (seed: number) => PDFHexString.of(Array.from({ length: 32 }, (_, i) => ((i * seed + 11) % 256).toString(16).padStart(2, "0")).join(""));
  const encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2, P: -4 });
  encrypt.set(doc.context.obj("O"), hex(7));
  encrypt.set(doc.context.obj("U"), hex(13));
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of("00112233445566778899aabbccddeeff"), PDFHexString.of("00112233445566778899aabbccddeeff")]);
  return doc.save({ useObjectStreams: false });
}

// Runs in the browser: a page of scattered thin strokes (like handwriting or smudges) that no engine can read or isolate.
function drawScribblesInBrowser(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1654;
  canvas.height = 2339;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 3;
  let state = 7;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let index = 0; index < 450; index++) {
    const x = 60 + random() * 1530;
    const y = 60 + random() * 2220;
    const angle = random() * Math.PI;
    const length = 25 + random() * 45;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

const mojibake = (text: string) =>
  new TextDecoder("windows-1252")
    .decode(Buffer.from(text, "utf8"))
    .replace(/[\u0080-\u009f]/g, "?")
    .replace(/[^\u0020-\u00ff\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/g, "?");

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const r = await Renderer.create(page);
  const stamp = r.stamp;
  const write = (id: string, bytes: Uint8Array) => writeFile(path.join(outDir, `${id}.pdf`), bytes);
  const degrade = async (png: Buffer, options: Degrade) =>
    toBuffer(await page.evaluate(degradeInBrowser, { dataUrl: `data:image/png;base64,${png.toString("base64")}`, options }));

  await write("native-congvan-1p", await r.pdf(templateHtml(congvan, stamp)));
  await write("native-table-1p", await r.pdf(templateHtml(tableLetter, stamp)));
  await write("native-list-3p", await r.pdf(templateHtml(listPlan, stamp)));
  await write("native-diacritics-1p", await r.pdf(templateHtml(diacritics, stamp)));
  await write("perf-native-10p", await r.pdf(templateHtml(longDocument(10, "Báo cáo tổng hợp"), stamp)));

  await write("scan-congvan-1p", await imagesToPdf(await r.screenshotPages(templateHtml(congvan, stamp))));
  await write("scan-table-1p", await imagesToPdf(await r.screenshotPages(templateHtml(tableLetter, stamp))));
  const [letterShot] = await r.screenshotPages(templateHtml(congvan, stamp));
  await write("scan-skewed-noisy-1p", await imagesToPdf([await degrade(letterShot, { skewDeg: 1, noise: 10, specks: 120, seed: 20261112 })]));
  const [diacriticsShot] = await r.screenshotPages(templateHtml(diacritics, stamp));
  await write("scan-rotated-1p", await imagesToPdf([await rotateCounterClockwise(page, diacriticsShot)], true));
  await write("perf-scan-5p", await imagesToPdf(await r.screenshotPages(templateHtml(longDocument(5, "Báo cáo quét"), stamp))));

  const lines = (items: Line[]) => items.map(lineHtml).join("");
  const bodyPng = await r.screenshotBody(lines(MIXED_SCANNED_BODY));
  const bodyUrl = `data:image/png;base64,${bodyPng.toString("base64")}`;
  await write(
    "mixed-header-native-body-scan",
    await r.pdf(pageHtml(`${lines(MIXED_HEADING)}<img class="body" alt="" src="${bodyUrl}">`) + pageHtml(lines(MIXED_NATIVE_PAGE2))),
  );

  const [badLayerShot] = await r.screenshotPages(pageHtml(lines(BAD_LAYER_SCANNED)));
  const layerText = BAD_LAYER_SCANNED.map((line) => mojibake(line.text)).join(" ");
  await write(
    "mixed-bad-text-layer",
    await r.pdf(
      pageHtml(`<img class="abs-img" alt="" src="data:image/png;base64,${badLayerShot.toString("base64")}"><div class="hidden-layer">${esc(layerText)}</div>`) +
        pageHtml(lines(BAD_LAYER_NATIVE_PAGE2)),
    ),
  );

  await write("limit-size-exact", await paddedPdf(TEN_MIB));
  await write("limit-size-over", await paddedPdf(TEN_MIB + 1));
  await write("limit-pages-20", await textPdf(Array.from({ length: 20 }, (_, i) => `Trang ${i + 1}`)));
  await write("limit-pages-21", await textPdf(Array.from({ length: 21 }, (_, i) => `Trang ${i + 1}`)));
  await write("blank-page-mid", await textPdf(["Trang 1", "", "Trang 3"]));
  await write("large-page-native", await textPdf(["Large format page 1"], [2384, 3370]));
  await write("protected-pdf", await protectedPdf());
  await write("scan-unreadable-1p", await imagesToPdf([toBuffer(await page.evaluate(drawScribblesInBrowser))]));
  const photo = `<div style="width:120mm;height:70mm;margin:14mm 0 0 15mm;background:linear-gradient(135deg,#101010,#8a8a8a)"></div>`;
  await write(
    "scan-figure-1p",
    await imagesToPdf(await r.screenshotPages(pageHtml(diacritics[0].blocks.map((block) => blockHtml(block, stamp)).join("") + photo))),
  );
  await write("invalid-not-pdf", new TextEncoder().encode("Day khong phai la tep PDF.\n"));
  await write("invalid-corrupt", new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 9 0 R"));

  await browser.close();
  await verify();
}

async function verify() {
  const rows: string[] = [];
  const extraPageCounts: Record<string, number> = { "limit-pages-21": 21 };
  for (const fixture of FIXTURES) {
    const bytes = await readFile(path.join(root, fixture.pdfPath));
    let pages = "-";
    if (!fixture.id.startsWith("invalid-")) {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const count = doc.getPageCount();
      const expected = fixture.pages.length || extraPageCounts[fixture.id];
      if (expected !== undefined && expected !== count) throw new Error(`${fixture.id}: expected ${expected} pages, generated ${count}`);
      pages = String(count);
    }
    if (fixture.id === "limit-size-exact" && bytes.length !== TEN_MIB) throw new Error("limit-size-exact is not exactly 10 MiB");
    if (fixture.id === "limit-size-over" && bytes.length !== TEN_MIB + 1) throw new Error("limit-size-over is not 10 MiB + 1");
    rows.push(`${fixture.id.padEnd(32)} ${fixture.category.padEnd(12)} pages=${pages.padStart(2)} bytes=${String(bytes.length).padStart(9)} modes=${fixture.pages.map((p) => p.mode[0]).join("") || "-"} tables=${fixture.expectedTableCount} art=${fixture.expectedArtworkCount} ${fixture.expectedOutcome}`);
  }
  console.log(rows.join("\n"));
  console.log(`\n${FIXTURES.length} fixtures verified in ${outDir}`);
}

await main();
