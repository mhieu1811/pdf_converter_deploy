import { describe, expect, it } from "vitest";
import type { FixtureCase } from "../fixtures/manifest";
import { assessGate, evaluateFixture, type Environment, type MeasuredFixture } from "./report";

const reference = (mode: "native" | "ocr", text: string, extra: Partial<FixtureCase> = {}, critical: string[] = []): FixtureCase => ({
  id: "synthetic",
  category: mode === "native" ? "native" : "scan",
  description: "synthetic",
  pdfPath: ".test-artifacts/fixtures/synthetic.pdf",
  pages: [{ mode, referenceText: text, criticalFields: critical }],
  expectedTableCount: 0,
  expectedArtworkCount: 0,
  expectedOutcome: "convert",
  ...extra,
});

const measured = (text: string, extra: Partial<MeasuredFixture> = {}): MeasuredFixture => ({
  id: "synthetic",
  outcome: "converted",
  pages: [{ text }],
  editableTables: 0,
  emptyTableCells: 0,
  pictures: 0,
  rasterizedPages: 0,
  warnings: [],
  elapsedMs: 100,
  requestsAfterInit: 0,
  ...extra,
});

/** Replaces the first `count` characters, so the error rate is exactly count / length. */
const corrupt = (text: string, count: number) => "x".repeat(count) + text.slice(count);
const body = (length: number) => "a".repeat(length);

describe("character error limits", () => {
  it("passes a native page at 0.5% and fails just above", () => {
    const ref = reference("native", body(1000));
    expect(evaluateFixture(ref, measured(corrupt(body(1000), 5)), "pass").status).toBe("pass");
    const over = evaluateFixture(ref, measured(corrupt(body(1000), 6)), "pass");
    expect(over.status).toBe("fail");
    expect(over.pageCer[0]).toBeCloseTo(0.006);
  });

  it("passes a scanned page at 2% and fails just above", () => {
    const ref = reference("ocr", body(2000));
    expect(evaluateFixture(ref, measured(corrupt(body(2000), 40)), "pass").status).toBe("pass");
    expect(evaluateFixture(ref, measured(corrupt(body(2000), 41)), "pass").status).toBe("fail");
  });

  it("does not average a bad page away", () => {
    const ref: FixtureCase = { ...reference("native", body(1000)), pages: [{ mode: "native", referenceText: body(1000), criticalFields: [] }, { mode: "native", referenceText: body(1000), criticalFields: [] }] };
    const result = evaluateFixture(ref, measured("", { pages: [{ text: body(1000) }, { text: corrupt(body(1000), 50) }] }), "pass");
    expect(result.status).toBe("fail");
    expect(result.failures.join(" ")).toContain("page 2");
  });
});

describe("critical fields", () => {
  it("fails a wrong date even though the overall error rate is tiny", () => {
    const text = `${body(2000)} ngày 12 tháng 11 năm 2026`;
    const ref = reference("native", text, {}, ["ngày 12 tháng 11 năm 2026"]);
    const result = evaluateFixture(ref, measured(text.replace("12 tháng", "13 tháng")), "pass");
    expect(result.pageCer[0]).toBeLessThan(0.001);
    expect(result.status).toBe("fail");
    expect(result.failures.join(" ")).toContain("ngày 12 tháng 11 năm 2026");
  });

  it("compares critical fields after Unicode and whitespace normalisation only", () => {
    const text = "Số: 125/SKH-VP";
    const ref = reference("native", text, {}, [text]);
    expect(evaluateFixture(ref, measured("S\u00f4\u0301:   125/SKH-VP"), "pass").status).toBe("pass");
    expect(evaluateFixture(ref, measured("So: 125/SKH-VP"), "pass").status).toBe("fail");
  });
});

describe("structure", () => {
  it("fails a missing stamp, a missing table, an empty cell and a flattened page", () => {
    const ref = reference("native", body(100), { expectedArtworkCount: 1, expectedTableCount: 1 });
    const good = measured(body(100), { pictures: 1, editableTables: 1 });
    expect(evaluateFixture(ref, good, "pass").status).toBe("pass");
    expect(evaluateFixture(ref, { ...good, pictures: 0 }, "pass").failures.join(" ")).toContain("artwork");
    expect(evaluateFixture(ref, { ...good, editableTables: 0 }, "pass").failures.join(" ")).toContain("table");
    expect(evaluateFixture(ref, { ...good, emptyTableCells: 2 }, "pass").failures.join(" ")).toContain("empty table cell");
    expect(evaluateFixture(ref, { ...good, rasterizedPages: 1 }, "pass").failures.join(" ")).toContain("rasterized");
  });

  it("fails a wrong page count", () => {
    expect(evaluateFixture(reference("native", body(100)), measured("", { pages: [{ text: body(100) }, { text: "" }] }), "pass").status).toBe("fail");
  });
});

describe("rejected inputs, privacy and performance", () => {
  it("expects invalid input to be refused with the right code", () => {
    const ref = reference("native", "", { pages: [], expectedOutcome: "reject", rejectCode: "INVALID_PDF" });
    expect(evaluateFixture(ref, measured("", { outcome: "rejected", rejectCode: "INVALID_PDF", pages: [] })).status).toBe("pass");
    expect(evaluateFixture(ref, measured("", { outcome: "rejected", rejectCode: "TOO_MANY_PAGES", pages: [] })).status).toBe("fail");
    expect(evaluateFixture(ref, measured("")).status).toBe("fail");
  });

  it("fails any network request made after initialization", () => {
    expect(evaluateFixture(reference("native", body(100)), measured(body(100), { requestsAfterInit: 1 }), "pass").status).toBe("fail");
  });

  it("holds the ten-page native document to 30 seconds and the five-page scan to 180 seconds", () => {
    const native = { ...reference("native", body(100)), id: "perf-native-10p" };
    expect(evaluateFixture(native, measured(body(100), { id: "perf-native-10p", elapsedMs: 30_000 }), "pass").status).toBe("pass");
    expect(evaluateFixture(native, measured(body(100), { id: "perf-native-10p", elapsedMs: 30_001 }), "pass").status).toBe("fail");
    const scan = { ...reference("ocr", body(100)), id: "perf-scan-5p" };
    expect(evaluateFixture(scan, measured(body(100), { id: "perf-scan-5p", elapsedMs: 180_001 }), "pass").status).toBe("fail");
  });
});

describe("Word inspection and the gate", () => {
  const ref = reference("native", body(100));

  it("never turns pending Word inspection into a pass", () => {
    expect(evaluateFixture(ref, measured(body(100))).status).toBe("pending-user-review");
    expect(evaluateFixture(ref, measured(body(100)), "pending").status).toBe("pending-user-review");
    expect(evaluateFixture(ref, measured(body(100)), "pass").status).toBe("pass");
    expect(evaluateFixture(ref, measured(body(100)), "fail").status).toBe("fail");
  });

  const environment: Environment = { browser: "Chromium 1", os: "macOS", cpu: "Apple M5", ramGb: 32, cores: 10, coldInitMs: 300 };
  const result = (status: "pass" | "fail" | "pending-user-review") => ({ id: "x", pageCer: [], failures: status === "fail" ? ["broken"] : [], wordInspection: "pending" as const, status });

  it("fails if any fixture fails, and stays pending without Word results or hardware evidence", () => {
    expect(assessGate([result("pass"), result("fail")], environment).status).toBe("fail");
    expect(assessGate([result("pass"), result("pending-user-review")], environment).status).toBe("pending-user-review");
    expect(assessGate([result("pass")], undefined).status).toBe("pending-user-review");
    expect(assessGate([result("pass")], { ...environment, ramGb: 4 }).status).toBe("pending-user-review");
    expect(assessGate([result("pass")], environment).status).toBe("pass");
  });
});
