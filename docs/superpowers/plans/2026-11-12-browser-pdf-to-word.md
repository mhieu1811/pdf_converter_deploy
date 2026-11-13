# Browser-only PDF to Word Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vietnamese-language, link-only PDF-to-editable-DOCX app without uploading documents, proving conversion quality before building the full product.

**Architecture:** Vercel serves a static React app and all engine assets. PDF parsing, rendering, OCR, layout reconstruction, and DOCX creation run in the user's browser with bounded workers and no document persistence. Tasks 1-5 establish feasibility; Tasks 6-8 are blocked until the user accepts measured results and local Word samples.

**Tech Stack:** React, TypeScript, Vite, PDF.js, Tesseract.js with `vie` and `eng` models, `docx`, Vitest, Playwright; `pdf-lib` for synthetic fixtures and `fflate` for local DOCX inspection (both development-only).

**Spec:** [Approved design](../specs/2026-11-12-browser-pdf-to-word-design.md). Read it before this plan.

## Global Constraints

- One file and one conversion job at a time.
- Initial proposed limits are 10 MiB and 20 pages inclusive.
- Native-text, scanned, and mixed PDFs, classified per page.
- Desktop Chrome and Edge stable are the initial support targets.
- No PDF bytes, filenames, extracted text, screenshots, document-derived metadata, or generated DOCX bytes leave the browser.
- No cloud backend or external API fallback is permitted.
- Static code/model caches are allowed; document content must not be written to localStorage, IndexedDB, Cache Storage, service-worker caches, or logs.
- Character error rate <= 0.5% for native pages and <= 2% for scan pages.
- No errors in the explicitly annotated synthetic reference document numbers, dates, and recipient names.
- UI remains interactive and cancellation is acknowledged within one second, with underlying processing terminated promptly.
- Provisional performance targets after warm initialization: a ten-page native fixture <= 30 seconds; a five-page clean scan fixture <= 180 seconds on a documented desktop with at least 8 GB RAM.
- Allow a baseline measurement and one focused improvement pass for observed failures, then report evidence.
- Proceed to the full MVP only if the targets pass and the user accepts the sample outputs.
- Do not silently relax targets, remove scan support, flatten pages, or add cloud processing.
- Actual UI copy uses proper Vietnamese accents. Documentation identifiers and test fixture IDs may be ASCII.
- Keep sensitive files out of this workspace, fixtures, Git, telemetry, browser automation artifacts, and cloud-assistant attachments.
- The user intends Claude Sonnet 4.6 to implement later. Do not start implementation as part of delivering this plan.

## Review Focus

Each condition below has a test assigned to its owning task.

1. A page with a small text header but a scanned body must not silently lose the body (Task 2).
2. A rotated scan or unusual page size must preserve reading order and respect the render cap (Tasks 2-3).
3. Missing/subset fonts or broken character maps must not become silently corrupted Vietnamese (Tasks 2-3).
4. Cancel followed immediately by another file must not expose stale results, leak object URLs, or leave OCR running (Task 6).
5. Image-heavy/table-heavy PDFs must not pass through as apparently successful editable Word while losing cells, text, or stamp artwork (Tasks 3-5).

## Execution boundaries

- Current workspace is not a Git repository and contains only this planning work.
  Do not assume npm dependencies, source code, fixtures, or verification results exist.
- Do not create a worktree before a repository exists. If implementing with Git,
  initialize it in this workspace, preserve the approved documents, and follow
  the applicable isolation workflow before product changes.
- Use inline/native execution for the later implementation session unless the
  user asks for subagents. Do not infer permission to change the selected model.
- Every task uses a failing behavioral test, minimal implementation, and a passing
  targeted check. Dependency/configuration setup is part of the task needing it.
- If Git is used, commit each passing task with only its named files staged.
  Include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
  unless the user opts out. Never stage private samples or generated artifacts.
- Stop at the Task 5 gate. A passing build is not permission to proceed.

## File map

Create these files when their tasks execute; do not generate the whole tree upfront.

| Files | Responsibility |
| --- | --- |
| `package.json`, lockfile, `index.html`, TypeScript/Vite/Vitest/Playwright configs | Static app and test tooling |
| `src/main.tsx`, `src/App.tsx`, `src/styles.css` | Minimal harness first; production Vietnamese UI after gate |
| `src/converter/types.ts` | Shared page/block, progress, warning, error, and result contracts |
| `src/converter/assets.ts`, `scripts/copy-engine-assets.mjs` | Self-hosted engine URLs and reproducible asset copying |
| `src/converter/pdf.ts` | Validation, page analysis, rendering, and PDF.js cleanup |
| `src/converter/ocr.ts` | Tesseract lifecycle and structured recognition |
| `src/converter/layout.ts` | Reading order and editable paragraph/table/image reconstruction |
| `src/converter/docx.ts` | OOXML generation from shared blocks |
| `src/converter/layout.worker.ts`, `src/converter/convert.ts` | CPU-heavy reconstruction/export and job orchestration |
| `src/converter/*.test.ts` | Focused pure-logic/unit tests beside implementation |
| `tests/fixtures/templates.ts`, `tests/fixtures/manifest.ts`, `scripts/generate-fixtures.ts` | Authored synthetic references and deterministic fixture generation |
| `tests/fixtures/assets/` | Redistributable reference font and license, mock artwork |
| `tests/e2e/*.spec.ts` | Real-browser integration, privacy, lifecycle, UI, and performance tests |
| `tests/benchmark/cer.ts`, `tests/benchmark/cer.test.ts` | Unicode-aware text error measurement |
| `tests/benchmark/report.ts` | Per-fixture evidence and gate assessment |
| `docs/quality-evaluation.md` | Synthetic benchmark report, Word inspection, approval record |
| `vercel.json`, `README.md`, `THIRD_PARTY_NOTICES.md`, `.gitignore` | Deployment policy, operation, license notices, safe exclusions |

Generated fixtures and reports go in ignored `.test-artifacts/`; never place
them in the production `public/` directory. Generated engine assets may live in
ignored `public/engine/`, recreated before development/build.

## Shared contracts

Define these in `src/converter/types.ts` as the relevant task needs them:

```ts
type PageMode = "native" | "ocr";
type Phase = "validating" | "analyzing" | "extracting" | "ocr" | "building";
type Progress = { phase: Phase; page?: number; totalPages?: number };
type Bounds = { x: number; y: number; width: number; height: number };
type TextSpan = {
  text: string; bounds: Bounds; fontSizePt: number;
  bold: boolean; italic: boolean;
};
type PageEvidence = {
  pageNumber: number; widthPt: number; heightPt: number; mode: PageMode;
  spans: TextSpan[];
  images: { bounds: Bounds; png: Uint8Array }[];
  horizontalRules: Bounds[]; verticalRules: Bounds[];
};
type ParagraphBlock = {
  kind: "paragraph"; spans: TextSpan[];
  alignment: "left" | "center" | "right" | "justify";
};
type TableBlock = {
  kind: "table"; rows: { cells: ParagraphBlock[][] }[];
  columnWidthsPt: number[];
};
type ImageBlock = { kind: "image"; png: Uint8Array; bounds: Bounds };
type Block = ParagraphBlock | TableBlock | ImageBlock;
type PageLayout = {
  pageNumber: number; widthPt: number; heightPt: number; blocks: Block[];
};
type Warning = {
  code: "OCR_REVIEW" | "FONT_SUBSTITUTED" | "RASTER_REGION" | "DOWNSCALED";
  pageNumber: number; message: string;
};
type ConversionResult = {
  blob: Blob; warnings: Warning[]; pageCount: number;
};
type ConvertOptions = {
  forceOcr: boolean; signal: AbortSignal;
  onProgress: (progress: Progress) => void;
};
```

Coordinates use points, with an upright page's top-left as origin; normalize
PDF rotation/transforms before emitting evidence. Page numbers are one-based.
`TableBlock.rows[n].cells[m]` contains the paragraphs for that cell.

Define `ConversionError extends Error` with a typed `code` and optional
`pageNumber`. Codes: `FILE_TOO_LARGE`, `TOO_MANY_PAGES`, `INVALID_PDF`,
`PROTECTED_PDF`, `ASSET_LOAD_FAILED`, `UNSUPPORTED_CONTENT`, `QUALITY_FAILURE`,
`RESOURCE_LIMIT`, `CONVERSION_FAILED`. Cancellation uses `AbortError`, never a
success-shaped empty result. Error messages must not embed document content.
Map errors to safe Vietnamese UI text, not raw library exceptions.

---

### Task 1: Establish a measurable browser feasibility harness

**Files:** Create tooling/config files, fixture files/scripts, benchmark files,
`src/main.tsx`, minimal `src/App.tsx`, `src/converter/types.ts`,
`tests/e2e/harness.spec.ts`, `.gitignore`, `THIRD_PARTY_NOTICES.md`.

**Interfaces:**
- Produces `characterErrorRate(reference: string, actual: string): number`.
- Produces `FixtureCase` in `tests/fixtures/manifest.ts` with `id`, `pdfPath`,
  `pages: { mode, referenceText, criticalFields }[]`, `expectedTableCount`,
  `expectedArtworkCount`, and `expectedOutcome: "convert" | "reject"`.
- Produces a React test harness using real file selection. No production styling.
- Produces scripts `dev`, `build`, `preview`, `typecheck`, `test`, `test:e2e`,
  `fixtures:generate`, `benchmark`, and `assets:copy`.

- [ ] **Step 1:** Create minimal React/Vite/TypeScript manifests and configs,
  preserving existing docs. Use npm and exact dependency versions; add Vitest,
  Playwright, `tsx`, `pdf-lib`, and `fflate` for validation. Install after manifests exist.
  `build` must type-check and create the static Vite build; `test` runs Vitest
  once. Configure Playwright's local `webServer` against `vite preview`, not the
  dev server; skip starting it when `BASE_URL` selects a deployed preview.
- [ ] **Step 2:** Write `cer.test.ts` and the harness test with these assertions:

  ```ts
  expect(characterErrorRate("abc", "adc")).toBeCloseTo(1 / 3);
  expect(characterErrorRate("a\u0301", "\u00e1")).toBe(0);
  expect(characterErrorRate("\u00e1", "a")).toBe(1);
  expect(characterErrorRate("a  b\nc", "a b c")).toBe(0);
  expect(characterErrorRate("", "x")).toBe(Infinity);
  // Real file input exists; no backend request is needed to mount the harness.
  ```

- [ ] **Step 3:** Run `npm run test -- tests/benchmark/cer.test.ts`.
  Expected: failed import/function assertion, not a missing test runner.
- [ ] **Step 4:** Implement CER using Unicode NFC, collapsed whitespace, and
  character-level Levenshtein distance over Unicode code points. Preserve
  punctuation, case, digits, and diacritics. Define empty/empty as zero and
  empty/nonempty as infinity. Add a minimal accessible file-input harness.
- [ ] **Step 5:** Author four native, four scanned, and two mixed cases with
  known reference text, table counts, and mock artwork. Include a rotated scan,
  bad OCR text layer, image body with text header, and font-encoding stress case.
  Add ten-page native/five-page scan performance fixtures and boundary/rejection
  variants. Generate PDFs from authored HTML using Chromium, rasterize scan
  variants, and assemble mixed variants with `pdf-lib`. Bundle a redistributable
  Vietnamese-capable reference font with its license; no real official artwork.
- [ ] **Step 6:** Implement fixture generation and a local-only fixture server
  in the test setup. References must come from authored text, never from the
  converter output being measured. Run `npm run fixtures:generate` and inspect
  the generated manifest counts and intended page modes.
- [ ] **Step 7:** Run `npm run test -- tests/benchmark/cer.test.ts`,
  `npm run build`, and `npm run test:e2e -- tests/e2e/harness.spec.ts`.
  Expected: all pass. If Playwright browsers are absent, install the required
  browser after the explicit missing-browser error and retry.
- [ ] **Step 8:** Commit the harness, measurement logic, synthetic sources,
  tooling, and license notices, excluding generated files.

### Task 2: Read PDFs and initialize all assets locally

**Files:** Create `assets.ts`, `pdf.ts`, initial `convert.ts`,
`scripts/copy-engine-assets.mjs`, `pdf.test.ts`, and `tests/e2e/pdf.spec.ts`;
extend shared types and harness.

**Interfaces:**
- `initializeEngines(): Promise<EngineSession>` in `convert.ts` (minimal startup
  implementation here, conversion implementation in Task 4).
- `EngineSession` owns initialized PDF/OCR/layout worker resources and exposes
  `dispose(): Promise<void>`; keep it opaque outside converter modules.
- `openPdf(file: File): Promise<PdfSession>` in `pdf.ts`.
- `PdfSession` exposes `pageCount: number`,
  `analyzePage(pageNumber: number): Promise<PageAnalysis>`,
  `renderPage(pageNumber: number): Promise<RenderedPage>`,
  `close(): Promise<void>`.
- `PageAnalysis` includes upright page dimensions, native text spans, image/rule
  geometry, and `mode: PageMode`. Define `RenderedPage` in shared types with
  `image: ImageBitmap`, `widthPt`, `heightPt`, `pixelWidth`, `pixelHeight` (numbers),
  and `warnings: Warning[]`, so OCR can convert rendered pixels back to points.
- `choosePageMode(analysis: PageAnalysisInput): PageMode` and
  `getRenderSize(widthPt: number, heightPt: number): { width: number; height: number; downscaled: boolean }`
  are pure functions. Define `PageAnalysisInput` from observed text quality and
  image coverage, not just string length.

- [ ] **Step 1:** Write unit/browser tests for the precise boundaries:
  size `10 * 1024 * 1024` passes the size check, one extra byte fails;
  20 pages pass, 21 fails. Also test corrupt, renamed non-PDF, protected PDF,
  blank page, bad text encoding, and the text-header/scanned-body fixture.
  Blank pages must not make the entire document fail.
- [ ] **Step 2:** Assert render pixels never exceed `12_000_000`, including
  oversized and rotated pages; bounds must stay within the normalized page.
  Assert native/mixed page modes match the reference manifest and invalid
  encodings route to OCR or fail explicitly, not silent mojibake.
- [ ] **Step 3:** Run `npm run test -- src/converter/pdf.test.ts`.
  Expected: failing cases for the unimplemented adapters/validation.
- [ ] **Step 4:** Implement validation and PDF.js adapters using public supported
  APIs. Disable active scripting/external resource behaviors. Determine text
  quality/coverage rules from the fixtures; do not claim perfect page detection.
  Start OCR renders around 200 DPI, reducing resolution to satisfy the cap.
- [ ] **Step 5:** Pin and copy PDF.js workers/support assets, Tesseract workers,
  WASM variants and `vie`/`eng` models into `public/engine/`. Configure explicit
  self-hosted paths and document model provenance/licenses. Connect asset copying
  to dev/build scripts. Fully initialize the supported assets before enabling
  file selection; show a typed startup error if loading fails. Do not add a
  service worker or fetch content-dependent resources from an external host.
- [ ] **Step 6:** Implement browser checks that initialize, switch offline, then
  open/render each fixture. Fail the test on attempted network requests after
  initialization, including attempted requests that would be blocked.
- [ ] **Step 7:** Run `npm run test -- src/converter/pdf.test.ts`,
  `npm run build`, and `npm run test:e2e -- tests/e2e/pdf.spec.ts`.
  Expected: validation, page analysis, resource limits, and offline rendering pass.
- [ ] **Step 8:** Commit PDF handling, reproducible assets, and their tests.

### Task 3: Recognize scans and reconstruct editable page structure

**Files:** Create `ocr.ts`, `layout.ts`, `layout.worker.ts`, `layout.test.ts`,
`tests/e2e/layout.spec.ts`; extend shared types and the PDF adapter as needed.

**Interfaces:**
- `recognizePage(rendered: RenderedPage, pageNumber: number, session: EngineSession, signal: AbortSignal): Promise<PageEvidence>`
  in `ocr.ts`; normalize OCR pixel coordinates into upright page points.
- `reconstructPage(evidence: PageEvidence): { layout: PageLayout; warnings: Warning[] }`
  in `layout.ts`.
- The top-level coordinator owns PDF.js and Tesseract workers. A separate
  top-level layout worker owns reconstruction and later OOXML export; no assumed
  unsupported nested-worker arrangement.
- Define a discriminated worker request/reply protocol in `types.ts` with
  `jobId`, `pageNumber` where applicable, and explicit success/error replies.
  Do not pass DOM objects or callbacks through structured cloning.

- [ ] **Step 1:** Write `layout.test.ts` using deliberately shuffled spans:
  the heading precedes the body; centered text stays centered; Vietnamese text
  survives exactly; a 2-by-3 table produces 2 rows and 3 cells per row.
  Assert duplicate hidden OCR/native text is not emitted twice.
- [ ] **Step 2:** Add integration cases asserting rotated scan reading order,
  forced OCR overriding a bad native layer, mixed per-page routing, and
  no missing body under a native header. Include cells containing multiple
  paragraphs, mock artwork near text, and a complex unsupported region.
- [ ] **Step 3:** Run `npm run test -- src/converter/layout.test.ts`.
  Expected: targeted reconstruction assertions fail.
- [ ] **Step 4:** Implement local `vie`/`eng` OCR with structured blocks enabled,
  sequential page processing and appropriate rotation handling. Do not use
  `data.text` alone to infer tables. Terminate OCR on abort and close bitmaps
  after each page. Emit `OCR_REVIEW` warnings for recognized pages.
- [ ] **Step 5:** Implement reconstruction from geometry: reading order,
  paragraphs/runs, alignment, simple ruled tables, and localized artwork.
  For raster pages, investigate bounded region/rule detection using the existing
  rendered bitmap before adding another dependency. Record limitations rather
  than pretending OCR provides image/table segmentation for free.
- [ ] **Step 6:** Preserve uncertain localized regions as images only with a
  `RASTER_REGION` warning. Throw `QUALITY_FAILURE` if important content cannot
  be preserved. Explicitly flag font substitution/downscaling. Complex tables
  need not become editable, but must never silently lose cells or contents.
- [ ] **Step 7:** Run `npm run test -- src/converter/layout.test.ts`,
  `npm run build`, and `npm run test:e2e -- tests/e2e/layout.spec.ts`.
  Expected: functional checks pass; unresolved fidelity issues are recorded for
  the feasibility gate, not suppressed or replaced with fake expected output.
- [ ] **Step 8:** Commit OCR/reconstruction and focused tests.

### Task 4: Export real DOCX through a cancellable offline pipeline

**Files:** Create `docx.ts`, `docx.test.ts`, `tests/e2e/conversion.spec.ts`;
complete `convert.ts`, `layout.worker.ts`, and the minimal harness.

**Interfaces:**
- `buildDocx(pages: PageLayout[]): Promise<Uint8Array>` in `docx.ts`,
  executed in the layout/export worker.
- `convertPdf(file: File, options: ConvertOptions, session: EngineSession): Promise<ConversionResult>`
  in `convert.ts`.
- Progress uses `Progress`; warnings use `Warning`; failure rejects with
  `ConversionError` or `AbortError`. No partial DOCX returned on hard failure.
- `EngineSession` allows one active conversion. Disposed/cancelled engines must
  be recreated before the next job, with initialization state shown explicitly.

- [ ] **Step 1:** Write export tests that unzip the result locally using
  development-only `fflate` and inspect OOXML. Assert editable text/diacritics,
  actual table cells, embedded mock artwork, expected source-page breaks, correct
  section dimensions, and absence of external relationships/macros. Avoid binary
  snapshots and assertions that merely count implementation function calls.
- [ ] **Step 2:** Write browser tests for real native, scanned, and mixed
  conversions with network requests blocked after startup. Assert a nonempty
  valid DOCX, correct page count, applicable warnings, and typed errors rather
  than a download for corrupt/unsupported input.
- [ ] **Step 3:** Run `npm run test -- src/converter/docx.test.ts`.
  Expected: export behavior fails before implementation.
- [ ] **Step 4:** Implement DOCX mapping with proper paragraphs, table cells,
  bounded images, source-page boundaries, standard fonts, and useful margins.
  Use the DOCX MIME type and a locally sanitized basename plus `.docx`.
  Do not add source file paths, external URLs, macros, or invented metadata.
- [ ] **Step 5:** Wire the sequential pipeline, worker progress, abort handling,
  typed errors, and cleanup. Keep heavy reconstruction/export off the UI thread;
  transfer buffers where safe. Release per-page bitmaps and do not retain
  duplicate full-document raster copies.
- [ ] **Step 6:** Run `npm run test -- src/converter/docx.test.ts`,
  `npm run build`, and `npm run test:e2e -- tests/e2e/conversion.spec.ts`.
  Expected: real offline conversion and OOXML checks pass.
- [ ] **Step 7:** Commit the functional prototype. Do not polish its UI yet.

### Task 5: Measure quality and enforce the go/no-go gate

**Files:** Complete `tests/benchmark/report.ts`; create
`tests/e2e/benchmark.spec.ts`, `tests/e2e/privacy.spec.ts`,
`docs/quality-evaluation.md`.

**Interfaces:**
- `evaluateFixture(reference: FixtureCase, actual: MeasuredFixture): FixtureResult`
  in `tests/benchmark/report.ts`.
- `MeasuredFixture` includes final DOCX text segmented by source page, critical
  fields, editable table/artwork counts, timings, warnings, and privacy results.
- `FixtureResult` includes per-page CER, structural pass/fail, and explicit
  `wordInspection: "pending" | "pass" | "fail"`.
- Final status is `"pass" | "fail" | "pending-user-review"`; never equate pending
  Word inspection or absent hardware metadata with a pass.

- [ ] **Step 1:** Write evaluator tests: a native CER of `0.005` passes while
  `0.0051` fails; a scan CER of `0.02` passes while `0.0201` fails; an incorrect
  annotated date fails despite low overall CER; missing artwork/table cells fail;
  all automated checks passing with Word inspection pending cannot yield pass.
- [ ] **Step 2:** Run `npm run test -- tests/benchmark`.
  Expected: evaluator tests fail before implementing the gate.
- [ ] **Step 3:** Implement per-page/per-fixture evaluation without averaging away
  a failing page or file. Extract final DOCX text, not just pre-export OCR text,
  for measurement. Store only synthetic results in test artifacts.
- [ ] **Step 4:** Add privacy tests covering conversion, cancellation, and errors.
  Assert no attempted requests after initialization, no document data in browser
  persistence, no document-bearing console output, and no external DOCX links.
  Include both text and scan paths; disable document-capturing traces/screenshots
  when any user performs a later private local check.
- [ ] **Step 5:** Run `npm run test -- tests/benchmark`, `npm run build`, and
  `npm run benchmark`. Run `npm run test:e2e -- tests/e2e/privacy.spec.ts`.
  Capture cold initialization time separately from the warm 30-second/180-second
  targets, record browser/OS/CPU/RAM, test the admitted upper limits, and retain
  every failure in the report.
- [ ] **Step 6:** Ask the user to inspect generated synthetic DOCX files locally
  in desktop Word: edit paragraphs and cells; check headings, margins, reading
  order, page breaks, missing/overlapping/clipped content, and mock stamp images.
  Record results in `docs/quality-evaluation.md`. If Word is unavailable, stop
  with inspection pending rather than substituting a browser preview.
- [ ] **Step 7:** If baseline fails, make at most one focused improvement pass,
  rerun affected tests and the benchmark, and retain baseline/final evidence.
  Failed targets remain failed unless the user explicitly approves a scope change.
- [ ] **Step 8:** Commit the synthetic benchmark tools/report. Request explicit
  acceptance of the output samples and gate decision. If acceptance is absent or
  any required result fails, STOP: do not execute Tasks 6-8.

---

## Conditional production work: requires the Task 5 approval

### Task 6: Build the Vietnamese UI and reliable job lifecycle

**Files:** Update `src/App.tsx`; create `src/styles.css`,
`tests/e2e/ui.spec.ts`, and `tests/e2e/lifecycle.spec.ts`.

**Interfaces:**
- Consume `initializeEngines`, `convertPdf`, shared progress/warnings/errors.
- The UI owns `AbortController`, job identity, download URL, and states
  `initializing`, `ready`, `validating`, `analyzing`, `extracting`, `ocr`,
  `building`, `completed`, `cancelled`, `failed`.
- A cancelled/failed engine session is disposed; file selection stays disabled
  while replacement engines initialize. Ignore messages from older job IDs.

- [ ] **Step 1:** Write UI tests for keyboard file selection and drag/drop,
  size/page-limit errors, OCR-all override, local source preview, progress
  announcements, warnings, download, reset, and unsupported-browser notice.
  Never expose a download button after a failed conversion.
- [ ] **Step 2:** Write lifecycle tests: cancel a real scan and acknowledge
  within `1000` ms; no subsequent progress/result from that job may appear.
  Replace it with a second file and assert only the second output appears.
  Also test double-click conversion, repeated reset, initialization failure,
  worker failure, and downloading before selecting the next file.
- [ ] **Step 3:** Run `npm run build` and
  `npm run test:e2e -- tests/e2e/ui.spec.ts tests/e2e/lifecycle.spec.ts`.
  Expected: new UI/lifecycle expectations fail against the prototype.
- [ ] **Step 4:** Build the minimal single-page Vietnamese interface from the
  design. Include the exact privacy meaning, file/page limits, scan-quality
  caveat, source preview and warnings. Use semantic HTML, labels, live status,
  visible focus, and known phase/page progress rather than a fake percentage.
- [ ] **Step 5:** Implement reset/replacement/unmount cleanup, revoke old preview
  and DOCX URLs, terminate workers on abort, and prevent overlapping conversions.
  Preserve no document history. Show that a saved download is not erased by reset.
  Error UI must be specific and safe, without logging raw PDF/library data.
- [ ] **Step 6:** Repeat the Step 3 commands. Expected: all UI and lifecycle
  checks pass and real OCR no longer runs after cancellation.
- [ ] **Step 7:** Commit the approved production UI and lifecycle tests.

### Task 7: Harden and verify the static Vercel deployment

**Files:** Create `vercel.json`; update asset/build scripts and
`tests/e2e/privacy.spec.ts`; create `tests/e2e/deployment.spec.ts`, `README.md`.

**Interfaces:**
- Vercel framework preset: Vite; build: `npm run build`; output: `dist`.
- No API routes, functions, external rewrites, database, or secret keys.
- Playwright accepts `BASE_URL` for deployed-site checks; fixture files remain
  local to the test runner and are passed to browser file inputs.

- [ ] **Step 1:** Add assertions for production asset headers/paths, worker and
  WASM startup, OCR model loading, no external scripts/fonts, no telemetry,
  protected framing/forms, and network-free conversion after initialization.
  Missing model assets must produce an explicit initialization error.
- [ ] **Step 2:** Run `npm run build` and
  `npm run test:e2e -- tests/e2e/deployment.spec.ts tests/e2e/privacy.spec.ts`.
  Expected: deployment/header expectations fail until configuration exists.
- [ ] **Step 3:** Add a restrictive CSP beginning with `default-src 'none'`,
  explicitly allowing self-hosted scripts/styles/fonts/assets and required local
  worker/image blobs. Allow only the narrow WASM permission actually needed,
  not general `unsafe-eval`. Set `object-src 'none'`, `base-uri 'none'`,
  `form-action 'none'`, `frame-ancestors 'none'`, and no external connections.
  Keep styles external or use an explicit CSP-compatible method; do not weaken
  policy to make incidental inline styling work.
- [ ] **Step 4:** Reproduce header rules in the local production-preview test
  setup so tests exercise the same policy. Verify caching/versioned model assets
  and correct MIME types; do not log document data. Do not add a service worker
  merely to make the offline assertion appear to pass.
- [ ] **Step 5:** Repeat Step 2. Expected: header, engine-startup, and privacy
  tests pass under the production policy, not just in a permissive dev server.
- [ ] **Step 6:** Document Vercel import/deployment steps, limits, supported
  browsers, model initialization download, lack of document uploads, visible
  page-request metadata, output-quality caveats, and safe local handling.
- [ ] **Step 7:** Deploy a preview only with the user's account/authorization.
  Run `BASE_URL=https://<preview-host> npm run test:e2e -- tests/e2e/deployment.spec.ts tests/e2e/privacy.spec.ts`
  using synthetic fixtures. Do not disable account protection automatically.
  If deployment credentials/permissions are unavailable, mark remote verification
  blocked and provide the exact manual steps; do not claim deployment succeeded.
- [ ] **Step 8:** Commit deployment configuration, tests, and operation docs.

### Task 8: Final acceptance and handoff

**Files:** Update `README.md` and `docs/quality-evaluation.md` only as needed.

**Interfaces:** Uses the production build and evidence from all previous tasks;
adds no new product scope.

- [ ] **Step 1:** Run `npm run typecheck`, `npm run test`, `npm run build`,
  `npm run test:e2e`, and `npm run benchmark`. Expected: all required checks pass;
  retain actual command results and disclose environment-specific blockers.
- [ ] **Step 2:** Repeat local Word inspection on representative native, scan,
  and mixed outputs from the production pipeline. Record both visual fidelity
  and editability; source-page breaks alone do not prove identical pagination.
- [ ] **Step 3:** Confirm Chrome and Edge behavior on available desktop machines.
  If Edge cannot be tested locally, assign a concrete manual acceptance check
  and mark it pending instead of treating Chromium-only results as Edge results.
- [ ] **Step 4:** Check the deployed preview's production privacy test results,
  cancellation behavior, model initialization, and 10-MiB/20-page boundaries.
  Resolve introduced regressions; do not expand scope to unrelated features.
- [ ] **Step 5:** Update the README and quality report with verified limitations,
  measured initialization/conversion times, tested environments, and pending
  checks. Remove only specifically identified temporary prototype artifacts
  that are no longer used; retain reproducible synthetic fixtures/tests.
- [ ] **Step 6:** Commit final documentation if Git is used. Report what is
  implemented, actual deployment URL if any, verification evidence, remaining
  limitations, and whether all acceptance gates passed.

## Completion criteria

Planning is complete when this plan and the approved design are saved and handed
to the user. No implementation result is implied.

Implementation is complete only when the quality gate is accepted, the static
app and deployment behavior are verified, documents remain local, and the user
can download a genuinely editable DOCX within the documented limitations.

## Suggested handoff message to Claude Sonnet 4.6

> Read the approved design and implementation plan linked above. Use
> `executing-plans` and implement Tasks 1-5 inline first. Do not upload documents,
> add a backend, or use an external OCR/conversion API. Start with synthetic
> fixtures and measure real output quality. Stop at Task 5, show the results and
> sample DOCX files for local Word inspection, and wait for my approval before
> Tasks 6-8. Never claim Word fidelity based only on unit tests or a successful build.
