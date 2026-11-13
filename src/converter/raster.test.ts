import { describe, expect, it } from "vitest";
import { detectColoredRegions, detectInkRegions, detectRules, estimateSkew, inkRatio, smoothFlags, strokeWidthRatio, type Pixels } from "./raster";

const SCALE = 2; // pixels per point

function blank(width: number, height: number): Pixels {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

function fill(image: Pixels, x: number, y: number, width: number, height: number, rgb: [number, number, number]) {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const offset = (row * image.width + column) * 4;
      image.data.set(rgb, offset);
    }
  }
}

function ring(image: Pixels, cx: number, cy: number, radius: number, rgb: [number, number, number]) {
  for (let row = 0; row < image.height; row++) {
    for (let column = 0; column < image.width; column++) {
      const distance = Math.hypot(column - cx, row - cy);
      if (Math.abs(distance - radius) < 2.5) image.data.set(rgb, (row * image.width + column) * 4);
    }
  }
}

const BLACK: [number, number, number] = [0, 0, 0];
const RED: [number, number, number] = [208, 32, 31];

describe("detectRules", () => {
  it("finds the ruled lines of a grid and reports them in points", () => {
    const image = blank(800, 600);
    for (const y of [100, 160, 220]) fill(image, 100, y, 400, 2, BLACK);
    for (const x of [100, 300, 500]) fill(image, x, 100, 2, 122, BLACK);
    const { horizontal, vertical } = detectRules(image, SCALE);
    expect(horizontal).toHaveLength(3);
    expect(vertical).toHaveLength(3);
    expect(horizontal[0].x).toBeCloseTo(50, 0);
    expect(horizontal[0].width).toBeGreaterThanOrEqual(200);
    expect(horizontal[0].width).toBeLessThanOrEqual(202);
    expect(horizontal[0].height).toBeLessThanOrEqual(2);
    expect(vertical[1].x).toBeCloseTo(150, 0);
    expect(vertical[1].height).toBeCloseTo(61, 0);
  });

  it("bridges a two-pixel scanning gap but ignores text-sized strokes and coloured ink", () => {
    const image = blank(800, 600);
    fill(image, 100, 100, 150, 2, BLACK);
    fill(image, 252, 100, 150, 2, BLACK);
    for (let x = 100; x < 700; x += 20) fill(image, x, 300, 8, 3, BLACK);
    fill(image, 100, 400, 400, 3, RED);
    const { horizontal, vertical } = detectRules(image, SCALE);
    expect(horizontal).toHaveLength(1);
    expect(horizontal[0].width).toBeGreaterThan(150);
    expect(vertical).toHaveLength(0);
  });
});

describe("detectColoredRegions", () => {
  it("finds a seal as one region, ignores red text-sized strokes and keeps separate seals apart", () => {
    const image = blank(1200, 1200);
    ring(image, 300, 300, 100, RED);
    ring(image, 300, 300, 80, RED);
    fill(image, 270, 290, 60, 20, RED);
    ring(image, 900, 300, 100, RED);
    fill(image, 100, 900, 400, 24, RED);
    const regions = detectColoredRegions(image, SCALE);
    expect(regions).toHaveLength(2);
    const [first] = regions.sort((a, b) => a.x - b.x);
    expect(first.x).toBeLessThanOrEqual(100);
    expect(first.x + first.width).toBeGreaterThanOrEqual(150);
    expect(first.width).toBeLessThan(120);
  });

  it("finds nothing on a black-and-white page", () => {
    const image = blank(600, 600);
    fill(image, 50, 50, 400, 300, BLACK);
    expect(detectColoredRegions(image, SCALE)).toEqual([]);
  });
});

describe("strokeWidthRatio", () => {
  const stems = (thickness: number) => {
    const image = blank(500, 120);
    for (let x = 20; x < 460; x += 16) fill(image, x, 40, thickness, 40, BLACK);
    return image;
  };
  const region = { x0: 0, x1: 500, baseline: 80 };

  it("reports stroke thickness relative to the font size, so bold reads thicker than regular", () => {
    expect(strokeWidthRatio(stems(3), region, 36)).toBeCloseTo(3 / 36);
    expect(strokeWidthRatio(stems(5), region, 36)).toBeCloseTo(5 / 36);
  });

  it("is zero where there is no ink", () => {
    expect(strokeWidthRatio(blank(500, 120), region, 36)).toBe(0);
  });
});

describe("estimateSkew", () => {
  function textLines(degrees: number): Pixels {
    const image = blank(900, 1200);
    const slope = Math.tan((degrees * Math.PI) / 180);
    for (let top = 150; top < 1050; top += 60) {
      for (let x = 100; x < 800; x++) {
        const centerY = Math.round(top + (x - 450) * slope);
        // Broken into word-like dashes so the lines look like text rather than rules.
        if (x % 50 < 40) fill(image, x, centerY - 6, 1, 12, BLACK);
      }
    }
    return image;
  }

  it("measures how far the text lines are turned, in degrees (clockwise positive)", () => {
    expect(estimateSkew(textLines(1.2))).toBeCloseTo(1.2, 0);
    expect(estimateSkew(textLines(-0.8))).toBeCloseTo(-0.8, 0);
  });

  it("reports an upright page as zero and ignores a nearly blank page", () => {
    expect(Math.abs(estimateSkew(textLines(0)))).toBeLessThan(0.15);
    expect(estimateSkew(blank(900, 1200))).toBe(0);
  });
});

describe("detectInkRegions", () => {
  it("keeps a dense unexplained block as a figure and reports that the rest of the ink is explained", () => {
    const image = blank(1200, 1200);
    fill(image, 200, 200, 300, 250, BLACK);
    fill(image, 600, 800, 400, 30, BLACK);
    const covered = [{ x: 280, y: 400, width: 215, height: 16 }];
    const { figures, unexplainedRatio } = detectInkRegions(image, SCALE, covered);
    expect(figures).toHaveLength(1);
    expect(figures[0].x).toBeLessThanOrEqual(100);
    expect(figures[0].width).toBeGreaterThanOrEqual(150);
    expect(unexplainedRatio).toBeLessThan(0.15);
  });

  it("does not turn a thin scan border into a figure", () => {
    const image = blank(1200, 1200);
    fill(image, 0, 0, 1200, 6, BLACK);
    fill(image, 0, 1194, 1200, 6, BLACK);
    fill(image, 0, 0, 6, 1200, BLACK);
    fill(image, 1194, 0, 6, 1200, BLACK);
    expect(detectInkRegions(image, SCALE, []).figures).toEqual([]);
  });

  it("reports scattered marks that nothing explains, without calling them figures", () => {
    const image = blank(1200, 1200);
    for (let index = 0; index < 60; index++) fill(image, 40 + (index % 10) * 110, 40 + Math.floor(index / 10) * 190, 50, 3, BLACK);
    const { figures, unexplainedRatio } = detectInkRegions(image, SCALE, []);
    expect(figures).toEqual([]);
    expect(unexplainedRatio).toBeGreaterThan(0.9);
  });

  it("has nothing to report on a blank page", () => {
    expect(detectInkRegions(blank(600, 600), SCALE, [])).toEqual({ figures: [], unexplainedRatio: 0 });
  });
});

describe("smoothFlags", () => {
  it("removes a flag that flips for a single word between two agreeing neighbours", () => {
    expect(smoothFlags([false, true, false, false])).toEqual([false, false, false, false]);
    expect(smoothFlags([true, false, true])).toEqual([true, true, true]);
  });

  it("keeps real runs and the ends of a line", () => {
    expect(smoothFlags([false, true, true, false])).toEqual([false, true, true, false]);
    expect(smoothFlags([true, false])).toEqual([true, false]);
    expect(smoothFlags([])).toEqual([]);
  });
});

describe("inkRatio", () => {
  it("is zero for a blank page and the dark share otherwise", () => {
    expect(inkRatio(blank(100, 100))).toBe(0);
    const image = blank(100, 100);
    fill(image, 0, 0, 10, 100, BLACK);
    expect(inkRatio(image)).toBeCloseTo(0.1);
  });
});
