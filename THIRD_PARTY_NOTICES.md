# Third-party notices

This project bundles or depends on the following open-source software. Versions are pinned in `package-lock.json`.
Before any public release, regenerate this list from the lockfile and include each full license text.

| Component | Role | License |
| --- | --- | --- |
| React, React DOM | Interface | MIT |
| PDF.js (`pdfjs-dist`) | PDF parsing and rendering, served from this deployment | Apache-2.0 |
| Tesseract.js (`tesseract.js`) and its WebAssembly core | Local OCR, served from this deployment | Apache-2.0 |
| Tesseract language data (`@tesseract.js-data/vie`, `@tesseract.js-data/eng`) | Vietnamese and English recognition models (`4.0.0_best_int`), served from this deployment | Package metadata: MIT; model data originates from the Tesseract `tessdata` project (Apache-2.0). Confirm provenance before release. |
| `docx` | DOCX generation | MIT |
| `pdf-lib` (development only) | Synthetic fixture assembly | MIT |
| `fflate` (development only) | Local DOCX inspection in tests | MIT |
| Noto Serif (`@fontsource/noto-serif`, development only) | Reference font for synthetic test fixtures (`tests/fixtures/assets/fonts`); not shipped in the production build | SIL Open Font License 1.1 (`tests/fixtures/assets/fonts/NotoSerif-OFL-LICENSE.txt`) |

Test fixtures are synthetic. They contain no real official seals, signatures or correspondence.
