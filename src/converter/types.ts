export type PageMode = "native" | "ocr";
export type Phase = "validating" | "analyzing" | "extracting" | "ocr" | "building";
export type Progress = { phase: Phase; page?: number; totalPages?: number };
export type Bounds = { x: number; y: number; width: number; height: number };

export type TextSpan = {
  text: string;
  bounds: Bounds;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  /** Source font name when the PDF reports one (native text only). */
  fontName?: string;
};

export type PageEvidence = {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  mode: PageMode;
  spans: TextSpan[];
  images: { bounds: Bounds; png: Uint8Array }[];
  horizontalRules: Bounds[];
  verticalRules: Bounds[];
};

export type ParagraphBlock = {
  kind: "paragraph";
  spans: TextSpan[];
  alignment: "left" | "center" | "right" | "justify";
  /** Indentation and spacing recovered from the source geometry, in points. */
  leftIndentPt?: number;
  firstLineIndentPt?: number;
  spaceBeforePt?: number;
  /** Exact line pitch of the source, in points. */
  lineSpacingPt?: number;
};

export type ImageBlock = { kind: "image"; png: Uint8Array; bounds: Bounds };

export type CellBlock = ParagraphBlock | ImageBlock;

export type TableBlock = {
  kind: "table";
  rows: { cells: CellBlock[][] }[];
  columnWidthsPt: number[];
  /** Left edge of the table on the page; the page margin is subtracted to get its indent. */
  xPt?: number;
  /** Source row heights, for ruled tables. */
  rowHeightsPt?: number[];
  /** False for borderless tables that only hold side-by-side columns of text. */
  bordered: boolean;
  spaceBeforePt?: number;
};

export type Block = ParagraphBlock | TableBlock | ImageBlock;

export type PageLayout = {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  blocks: Block[];
  /** Margins that put the first content where it was on the source page. */
  marginsPt?: { top: number; right: number; bottom: number; left: number };
};

/** What PDF.js reports about one page, in upright points with a top-left origin. */
export type PageAnalysis = {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  mode: PageMode;
  text: string;
  spans: TextSpan[];
  imageBounds: Bounds[];
  horizontalRules: Bounds[];
  verticalRules: Bounds[];
  textCoverage: number;
  imageCoverage: number;
  suspiciousRatio: number;
};

export type RenderedPage = {
  image: ImageBitmap;
  widthPt: number;
  heightPt: number;
  pixelWidth: number;
  pixelHeight: number;
  warnings: Warning[];
};

export type Warning = {
  code: "OCR_REVIEW" | "FONT_SUBSTITUTED" | "RASTER_REGION" | "DOWNSCALED" | "LAYOUT_APPROXIMATED";
  pageNumber: number;
  message: string;
};

export type ConversionResult = {
  blob: Blob;
  warnings: Warning[];
  pageCount: number;
};

export type ConvertOptions = {
  forceOcr: boolean;
  signal: AbortSignal;
  onProgress: (progress: Progress) => void;
};

/** Messages between the main thread and the layout worker. */
export type LayoutRequest =
  | { type: "ping"; jobId: number }
  | { type: "reconstruct"; jobId: number; evidence: PageEvidence }
  | { type: "build"; jobId: number; pages: PageLayout[] };
export type LayoutReply =
  | { type: "pong"; jobId: number }
  | { type: "reconstructed"; jobId: number; layout: PageLayout; warnings: Warning[] }
  | { type: "built"; jobId: number; bytes: Uint8Array }
  | { type: "error"; jobId: number; message: string };

export type ConversionErrorCode =
  | "FILE_TOO_LARGE"
  | "TOO_MANY_PAGES"
  | "INVALID_PDF"
  | "PROTECTED_PDF"
  | "ASSET_LOAD_FAILED"
  | "UNSUPPORTED_CONTENT"
  | "QUALITY_FAILURE"
  | "RESOURCE_LIMIT"
  | "CONVERSION_FAILED";

/** Messages must never embed document content. */
export class ConversionError extends Error {
  readonly code: ConversionErrorCode;
  readonly pageNumber?: number;

  constructor(code: ConversionErrorCode, message: string, options: { pageNumber?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ConversionError";
    this.code = code;
    this.pageNumber = options.pageNumber;
  }
}
