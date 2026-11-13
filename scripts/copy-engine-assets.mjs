import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = path.join(root, "node_modules");
const out = path.join(root, "public", "engine");

rmSync(out, { recursive: true, force: true });

function copy(from, to) {
  if (!existsSync(from)) throw new Error(`Missing engine file: ${path.relative(root, from)} (run npm install)`);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function copyMatching(fromDir, toDir, predicate) {
  const names = readdirSync(fromDir).filter(predicate).sort();
  for (const name of names) copy(path.join(fromDir, name), path.join(toDir, name));
  return names;
}

const pdfjs = path.join(modules, "pdfjs-dist");
const pdfjsOut = path.join(out, "pdfjs");
copy(path.join(pdfjs, "build", "pdf.worker.min.mjs"), path.join(pdfjsOut, "pdf.worker.min.mjs"));
copy(path.join(pdfjs, "LICENSE"), path.join(pdfjsOut, "LICENSE"));
const cmaps = copyMatching(path.join(pdfjs, "cmaps"), path.join(pdfjsOut, "cmaps"), (name) => name.endsWith(".bcmap"));
copyMatching(path.join(pdfjs, "cmaps"), path.join(pdfjsOut, "cmaps"), (name) => name === "LICENSE");
const standardFonts = copyMatching(path.join(pdfjs, "standard_fonts"), path.join(pdfjsOut, "standard_fonts"), (name) => /\.(ttf|pfb)$/.test(name));
copyMatching(path.join(pdfjs, "standard_fonts"), path.join(pdfjsOut, "standard_fonts"), (name) => name.startsWith("LICENSE"));
const wasm = copyMatching(path.join(pdfjs, "wasm"), path.join(pdfjsOut, "wasm"), (name) => name.endsWith(".wasm") && !name.startsWith("quickjs"));
copyMatching(path.join(pdfjs, "wasm"), path.join(pdfjsOut, "wasm"), (name) => name.startsWith("LICENSE"));

const tesseractOut = path.join(out, "tesseract");
copy(path.join(modules, "tesseract.js", "dist", "worker.min.js"), path.join(tesseractOut, "worker.min.js"));
copy(path.join(modules, "tesseract.js", "LICENSE.md"), path.join(tesseractOut, "LICENSE-tesseract.js.md"));
copy(path.join(modules, "tesseract.js-core", "LICENSE"), path.join(tesseractOut, "LICENSE-tesseract.js-core.txt"));
copyMatching(path.join(modules, "tesseract.js-core"), path.join(tesseractOut, "core"), (name) => /^tesseract-core.*-lstm\.wasm\.js$/.test(name));
for (const lang of ["vie", "eng"]) {
  copy(
    path.join(modules, "@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`),
    path.join(tesseractOut, "lang", `${lang}.traineddata.gz`),
  );
}

writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify({ pdfjs: { cmaps, standardFonts, wasm } }, null, 2)}\n`);
console.log(`engine assets: ${cmaps.length} cmaps, ${standardFonts.length} fonts, ${wasm.length} wasm`);
