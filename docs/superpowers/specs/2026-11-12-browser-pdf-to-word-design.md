# Browser-only PDF to Word: design for approval

Date: 2026-11-12
Status: Approved by the user in this session on 2026-11-12.
Implementation owner: User's chosen Claude Sonnet 4.6 session.
Current deliverable: Design and implementation plan only, not product code.

## 1. Intent and confirmed requirements

Build a simple Vietnamese-language web app for converting one PDF to an
editable Word document (.docx). Typical inputs are official correspondence,
including native-text PDFs, scanned documents, and documents containing both.
Preserve content and formatting as well as practical; do not promise perfect
reproduction.

The user wants to open a link without installing a local service. Deploy the
website to Vercel. Documents and extracted content must not be sent to Vercel,
an external conversion service, or any other third party. The user has no
internal server and selected browser-only processing with quality validation
before full implementation.

The assumptions and numeric targets below are design proposals, not measured
results or requirements previously supplied by the user.

## 2. Approaches considered

1. Browser-only processing, static UI on Vercel: selected. Meets the link-only
   workflow without uploading documents. OCR, memory use, and reconstruction
   quality are the major feasibility risks.
2. Vercel UI plus a local conversion service: potentially broader engine choice,
   but requires installation and a protected browser-to-local connection.
   Rejected for the desired no-install experience.
3. Fully local/internal web app: users could open an internal link and use a
   shared native engine, but no internal host is available.
4. Conversion on Vercel or Cloudflare: uploading documents conflicts with the
   privacy requirement. SSR renders HTML; it does not solve conversion.
   Cloudflare Workers Free also has insufficient CPU allowance for this OCR
   workload. No cloud backend or external API fallback is permitted.

## 3. Scope and non-goals

### Intended MVP, conditional on the feasibility gate

- One file and one conversion job at a time.
- Native-text, scanned, and mixed PDFs, classified per page.
- Editable Vietnamese and English text, paragraphs, headings, basic alignment,
  simple tables, approximate margins, and source-page boundaries where feasible.
- Preserve visible signature/stamp artwork as images where reliably isolated.
  These images do not constitute a valid digital signature.
- Local preview of the source, progress by phase/page, cancellation, explicit
  quality warnings, Word download, and reset.
- Desktop Chrome and Edge stable are the initial support targets.

### Not included

- Accounts, database, upload endpoint, server functions, analytics, cloud OCR,
  batch conversion, document history, or persistent document storage.
- Exact font recovery, guaranteed identical pagination, handwriting recognition,
  legally valid signature transfer, or automatic reconstruction of every complex
  multi-column/merged-table layout.
- Password-protected PDFs in the MVP: report unsupported protection explicitly.
- Mobile/Safari/Firefox support guarantees; show a compatibility notice.
- A page-image-only Word file presented as an editable conversion.

## 4. Proposed architecture

Use React, TypeScript, and Vite with a small responsive stylesheet. A static
build is sufficient on Vercel; Next.js and SSR add no needed capability here.
Pin compatible stable dependencies and retain their license notices.

Candidate components to evaluate, not a proven conversion engine:

- PDF.js (`pdfjs-dist`): parse PDFs, expose text coordinates, render pages.
- Tesseract.js: local WebAssembly OCR with Vietnamese and English language data.
  It does not read PDFs directly; PDF.js must render scan pages first.
  Explicitly request supported structured OCR output, not just plain text.
- `docx`: generate editable OOXML paragraphs, runs, tables, and images.
  This library writes Word documents; it does not reconstruct PDF layout.
- Web Workers: isolate CPU-heavy analysis and conversion from the UI.
  Respect each library's worker model rather than blindly nesting workers.

Pipeline:

    Vercel serves static code and engine assets
                     |
                     v
    Browser initializes engines -> user selects a local PDF
                     |
                     v
    Validate -> analyze pages -> text extraction or local OCR
                     |
                     v
    Reconstruct blocks/tables/images -> generate DOCX -> local download

No PDF bytes, filenames, extracted text, screenshots, document-derived
metadata, or generated DOCX bytes leave the browser.

## 5. Processing and fidelity behavior

Validate byte size, PDF structure through the parser, page count, and protection
before conversion. Initial proposed limits are 10 MiB and 20 pages inclusive.
Reject over-limit, corrupt, and unsupported inputs with a useful Vietnamese
message; a renamed extension or MIME type alone is not validation.

Analyze pages independently. Text quantity alone cannot establish that a page
has a usable text layer: examine text quality and coverage to catch bad hidden
OCR and image-heavy pages. The prototype must include these cases. Offer an
"OCR all pages" override when automatic classification is wrong.

For native text, use coordinates and styles to infer lines, paragraphs, reading
order, alignment, and basic tables. For scanned pages, render and OCR sequentially,
then infer layout from recognized blocks and geometry. OCR does not supply a
finished editable Word layout.

Use one shared intermediate page/block representation for both branches.
Map supported blocks to real DOCX paragraphs and table cells. Prefer explicit
page breaks corresponding to source pages, but report that Word font metrics
and reflow can still change pagination. Use a standard font mapping; do not
silently assume a subsetted embedded PDF font is available in Word.

For important artwork or complex regions, retain a localized image only when it
can be reliably isolated without dropping content. Mark image-only regions in
the completion warnings; do not silently flatten the entire document. If an
important region cannot be preserved, show an explicit quality failure and do
not label the result successful. Do not invent text or inferred missing content.

Process one page at a time and release rendered bitmaps promptly. Start near
200 DPI for OCR and calibrate in the prototype; cap each render at 12 megapixels,
scaling down with a quality warning when necessary. Use a small, bounded worker
count. Cancellation must stop work, not just hide progress. Disable overlapping
jobs and ignore stale worker messages after cancellation/reset.

On cancellation, reset, replacement, or error, dispose of document-specific
workers/resources as appropriate and revoke output object URLs. Keep a completed
output only in memory until reset/replacement or tab closure. Do not claim secure
memory erasure or deletion of downloads already saved by the user.

## 6. Privacy and deployment boundary

Serve all JavaScript, worker code, WASM, OCR language files, PDF support assets,
and fonts from the same static deployment. Do not use runtime CDNs, remote fonts,
remote error reporting, Vercel Analytics, or third-party scripts.

Initialize required assets before enabling file selection. The acceptance test
must demonstrate conversion with network access blocked after initialization,
including both native-text and scan fixtures. Asset-loading failures must be
shown before processing; never fall back to a hosted engine.

The builder must identify and bundle PDF.js support assets required by the
supported fixture set, including font/CMap needs, rather than assuming the JS
bundle alone is sufficient. Unsupported font/encoding cases must be surfaced.
Static code/model caches are allowed; document content must not be written to
localStorage, IndexedDB, Cache Storage, service-worker caches, or logs.

Use a production Content Security Policy restricted to necessary self-hosted
assets, workers, and local blobs. Add only the narrow WASM execution permission
required by the tested engines, not blanket unrestricted scripting. Disallow
external connections, form submissions, and framing. Avoid rendering PDF active
content or extracted text as HTML; generated documents must not contain external
resource relationships or macros.

Verify the production build and actual Vercel preview, not just the development
server. Use synthetic, non-sensitive files for deployment validation.

The hosting service still sees ordinary page/asset requests, IP addresses, and
browser metadata. "No document upload" is not "no contact with Vercel." Browser
extensions, compromised deployed code, OS memory/swap, and organizational rules
about using externally hosted software remain outside this app's guarantee.
Sensitive samples must never be attached to a cloud coding assistant or committed.

## 7. UI behavior

Keep the interface simple, in Vietnamese. The visual styling is left to the
builder; no visual prototype is required before the feasibility decision.

    PDF -> Word
    Tai lieu duoc xu ly tren trinh duyet, khong tai len may chu.

    [Chon PDF / keo tha]       Toi da 10 MiB, 20 trang
    [ ] OCR tat ca cac trang
    [Chuyen sang Word]

    Dang xu ly trang 3/8 ...                       [Huy]
    Canh bao chat luong: ...
    [Tai Word]                                    [Chon file khac]

The sketch uses ASCII only for documentation; actual UI copy uses proper
Vietnamese accents. States: initializing assets, ready, validating, analyzing,
extracting/OCR, building Word, completed with warnings, cancelled, and failed.
Do not invent a smooth percentage; show known phase/page progress. Include
accessible labels, keyboard file selection, announced status, and visible errors.

## 8. Feasibility gate: build this before the full application

The first implementation milestone is a disposable local browser prototype,
not the polished product. Evaluate extraction, OCR, reconstruction, image
preservation, DOCX editability, privacy, and performance end to end.

Create developer-authored synthetic correspondence fixtures with known source
text and reference layouts: at least four native PDFs, four scanned PDFs, and
two mixed PDFs. Cover Vietnamese diacritics, headers/date blocks, lists,
multi-page content, a simple table, mock stamp/signature artwork, and an
intentionally poor text layer. Include a clean scan and a skewed/noisy scan.
Do not reproduce real official seals, signatures, or sensitive correspondence.

Record per-fixture and per-page results. Proposed pass criteria:

1. Editability: paragraphs are editable text and simple tables are real Word
   tables. A page screenshot in a DOCX is not a pass.
2. Text: character error rate <= 0.5% for native pages and <= 2% for scan pages.
   CER is character-level Levenshtein distance / reference character count,
   after Unicode NFC normalization and whitespace normalization only. Preserve
   diacritics, punctuation, and numbers. Report each fixture separately.
3. Critical fields: no errors in the explicitly annotated synthetic reference
   document numbers, dates, and recipient names; do not auto-correct by guessing.
4. Layout: no missing/duplicated paragraphs, wrong reading order, clipped or
   overlapping text, missing table cells, lost mock signature/stamp artwork, or
   unintended full-page rasterization. Headers, margins, table structure, and
   page breaks must remain practically usable in desktop Word.
5. Privacy: no network requests after engine initialization during selection,
   conversion, download generation, cancellation, or error handling; no persisted
   document data. Test native, scanned, and mixed fixtures.
6. Responsiveness: UI remains interactive and cancellation is acknowledged
   within one second, with underlying processing terminated promptly.
7. Provisional performance targets after warm initialization: a ten-page native
   fixture <= 30 seconds; a five-page clean scan fixture <= 180 seconds on a
   documented desktop with at least 8 GB RAM. Record hardware, browser, asset
   initialization time separately, and whether admitted upper-bound documents
   complete without crashing. These are targets to validate, not promises.

An implementer can automate text, OOXML, lifecycle, and network checks. The user
must inspect the resulting fixtures locally in desktop Microsoft Word for
editability and visual fidelity. If Word is unavailable, mark this validation
pending; a DOCX parser or browser preview is not a substitute. Do not upload
real documents to an online viewer to perform this check.

Allow a baseline measurement and one focused improvement pass for observed
failures, then report evidence. Proceed to the full MVP only if the targets
pass and the user accepts the sample outputs. Otherwise stop and explain the
failing cases, effort, and options. Do not silently relax targets, remove scan
support, flatten pages, or add cloud processing. New trade-offs require approval.

## 9. Validation after the gate

- Unit tests for geometry/reading-order logic, routing bad text layers to OCR,
  content mapping, and precise boundary validation.
- Integration tests for real DOCX text/tables/images and absent external links.
- Browser tests for real extraction/OCR, blocked-network conversion, limits,
  corrupt/protected files, cancellation, replacement, reset, and worker errors.
- Production type-check, tests, and build with the chosen repository tooling.
- Vercel preview checks for worker/WASM/model loading and CSP, using synthetic
  files only. Re-run privacy checks on the deployed production build.
- Repeat local Word inspection on representative native, scan, and mixed outputs.

## 10. Handoff and builder discretion

The plan must separate feasibility work from conditional production work and
include exact commands, expected checks, and stop conditions. It must not tell
the implementer to build the full UI before validating the core conversion.

The builder chooses compatible dependency versions, the small internal module
layout, test runner setup, supported PDF.js APIs, OCR output settings, and
geometry heuristics based on the prototype evidence. Do not build a generic
plugin system, server API, task queue, or framework for hypothetical engines.

The user selected Claude Sonnet 4.6 for later implementation. This design does
not launch that implementation or change the current assistant's model.

## Sources checked

- PDF.js display/core responsibilities and support assets:
  https://mozilla.github.io/pdf.js/getting_started/
- Tesseract.js browser OCR, lack of direct PDF support, structured-output options:
  https://github.com/naptha/tesseract.js
- DOCX generation:
  https://docx.js.org/
- Cloudflare Workers resource limits:
  https://developers.cloudflare.com/workers/platform/limits/
- Vercel Python backend capability (considered, not selected):
  https://vercel.com/docs/functions/runtimes/python
