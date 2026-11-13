import { describe, expect, it } from "vitest";
import { groupWarnings, missingFeatures } from "./ui";
import type { Warning } from "./converter/types";

const modern = { Worker: class {}, OffscreenCanvas: class {}, WebAssembly: {}, createImageBitmap: () => undefined, AbortController: class {}, Blob: class {}, URL: { createObjectURL: () => "" } };

describe("missingFeatures", () => {
  it("reports nothing for a browser that has every required capability", () => {
    expect(missingFeatures(modern)).toEqual([]);
  });

  it("names each missing capability", () => {
    const { OffscreenCanvas: _canvas, WebAssembly: _wasm, ...rest } = modern;
    expect(missingFeatures(rest).sort()).toEqual(["OffscreenCanvas", "WebAssembly"]);
  });
});

describe("groupWarnings", () => {
  const warning = (code: Warning["code"], pageNumber: number, message = `msg ${code}`): Warning => ({ code, pageNumber, message });

  it("merges the same warning from many pages into one line with its pages", () => {
    const grouped = groupWarnings([warning("OCR_REVIEW", 1), warning("RASTER_REGION", 1), warning("OCR_REVIEW", 2), warning("OCR_REVIEW", 4)]);
    expect(grouped).toEqual([
      { message: "msg OCR_REVIEW", pages: [1, 2, 4] },
      { message: "msg RASTER_REGION", pages: [1] },
    ]);
  });

  it("counts a page once even if it repeats the warning (several stamps)", () => {
    expect(groupWarnings([warning("RASTER_REGION", 1), warning("RASTER_REGION", 1)])).toEqual([{ message: "msg RASTER_REGION", pages: [1] }]);
  });

  it("returns nothing when there is nothing to warn about", () => {
    expect(groupWarnings([])).toEqual([]);
  });
});
