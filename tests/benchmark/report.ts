import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FIXTURES, type FixtureCase } from "../fixtures/manifest";
import { characterErrorRate, normalizeForComparison } from "./cer";

// Targets from the approved design (section 8).
export const THRESHOLDS = {
  nativeCer: 0.005,
  scanCer: 0.02,
  maxMsById: { "perf-native-10p": 30_000, "perf-scan-5p": 180_000 } as Record<string, number>,
  minRamGb: 8,
};

export type WordInspection = "pending" | "pass" | "fail";
export type FixtureStatus = "pass" | "fail" | "pending-user-review";

export type MeasuredFixture = {
  id: string;
  outcome: "converted" | "rejected";
  rejectCode?: string;
  /** Text of the final DOCX, one entry per source page. */
  pages: { text: string }[];
  /** Bordered Word tables that hold text. */
  editableTables: number;
  emptyTableCells: number;
  pictures: number;
  /** Pages whose picture covers most of the page, i.e. a flattened page. */
  rasterizedPages: number;
  warnings: string[];
  elapsedMs: number;
  /** Network requests made during this conversion, after engine initialization. */
  requestsAfterInit: number;
};

export type Environment = { browser: string; os: string; cpu: string; ramGb: number; cores: number; coldInitMs: number };

export type FixtureResult = {
  id: string;
  pageCer: number[];
  failures: string[];
  wordInspection: WordInspection;
  status: FixtureStatus;
};

const normalized = (text: string) => normalizeForComparison(text);

export function evaluateFixture(reference: FixtureCase, actual: MeasuredFixture, wordInspection: WordInspection = "pending"): FixtureResult {
  const failures: string[] = [];
  const pageCer: number[] = [];

  if (reference.expectedOutcome === "reject") {
    if (actual.outcome !== "rejected") failures.push("converted although the input must be refused");
    else if (actual.rejectCode !== reference.rejectCode) failures.push(`refused with ${actual.rejectCode}, expected ${reference.rejectCode}`);
    return { id: reference.id, pageCer, failures, wordInspection: "pass", status: failures.length ? "fail" : "pass" };
  }

  if (actual.outcome !== "converted") {
    failures.push(`not converted (${actual.rejectCode ?? "unknown"})`);
  } else {
    if (actual.pages.length !== reference.pages.length) failures.push(`${actual.pages.length} pages, expected ${reference.pages.length}`);
    reference.pages.forEach((expected, index) => {
      const text = actual.pages[index]?.text ?? "";
      const rate = characterErrorRate(expected.referenceText, text);
      pageCer.push(rate);
      const limit = expected.mode === "native" ? THRESHOLDS.nativeCer : THRESHOLDS.scanCer;
      if (rate > limit) failures.push(`page ${index + 1}: character error rate ${(rate * 100).toFixed(2)}% exceeds ${(limit * 100).toFixed(1)}%`);
      for (const field of expected.criticalFields) {
        if (!normalized(text).includes(normalized(field))) failures.push(`page ${index + 1}: critical field not found exactly: "${field}"`);
      }
    });
    if (actual.editableTables !== reference.expectedTableCount) failures.push(`${actual.editableTables} editable tables, expected ${reference.expectedTableCount}`);
    if (actual.pictures !== reference.expectedArtworkCount) failures.push(`${actual.pictures} artwork images, expected ${reference.expectedArtworkCount}`);
    if (actual.emptyTableCells > 0) failures.push(`${actual.emptyTableCells} empty table cell(s)`);
    if (actual.rasterizedPages > 0) failures.push(`${actual.rasterizedPages} page(s) rasterized into a picture`);
    const maxMs = THRESHOLDS.maxMsById[reference.id];
    if (maxMs !== undefined && actual.elapsedMs > maxMs) failures.push(`took ${(actual.elapsedMs / 1000).toFixed(1)} s, target ${maxMs / 1000} s`);
  }
  if (actual.requestsAfterInit > 0) failures.push(`${actual.requestsAfterInit} network request(s) after initialization`);

  if (wordInspection === "fail") failures.push("failed inspection in desktop Word");
  const status: FixtureStatus = failures.length ? "fail" : wordInspection === "pass" ? "pass" : "pending-user-review";
  return { id: reference.id, pageCer, failures, wordInspection, status };
}

export function assessGate(results: FixtureResult[], environment: Environment | undefined): { status: FixtureStatus; reasons: string[] } {
  const reasons: string[] = [];
  const failed = results.filter((result) => result.status === "fail");
  if (failed.length) return { status: "fail", reasons: failed.map((result) => `${result.id}: ${result.failures.join("; ")}`) };
  const pending = results.filter((result) => result.status === "pending-user-review");
  if (pending.length) reasons.push(`Word inspection pending for ${pending.length} fixture(s)`);
  if (!environment) reasons.push("hardware and browser were not recorded");
  else if (environment.ramGb < THRESHOLDS.minRamGb) reasons.push(`machine has ${environment.ramGb.toFixed(1)} GB RAM, targets assume at least ${THRESHOLDS.minRamGb} GB`);
  return { status: reasons.length ? "pending-user-review" : "pass", reasons };
}

// ---------------------------------------------------------------------------
// Command line: summarise .test-artifacts/benchmark/measurements.json.

type Measurements = { environment: Environment; fixtures: MeasuredFixture[]; privacy?: Record<string, unknown> };

function main() {
  const dir = path.resolve(".test-artifacts", "benchmark");
  const measurementsPath = path.join(dir, "measurements.json");
  if (!existsSync(measurementsPath)) throw new Error("Run `npx playwright test tests/e2e/benchmark.spec.ts` first.");
  const measurements = JSON.parse(readFileSync(measurementsPath, "utf8")) as Measurements;
  const inspectionPath = path.join(dir, "word-inspection.json");
  const inspections: Record<string, WordInspection> = existsSync(inspectionPath) ? JSON.parse(readFileSync(inspectionPath, "utf8")) : {};

  const results = FIXTURES.map((fixture) => {
    const actual = measurements.fixtures.find((item) => item.id === fixture.id);
    if (!actual) return { id: fixture.id, pageCer: [], failures: ["not measured"], wordInspection: "pending" as const, status: "fail" as const };
    return evaluateFixture(fixture, actual, inspections[fixture.id] ?? "pending");
  });
  const gate = assessGate(results, measurements.environment);

  const lines = results.map((result) => {
    const rates = result.pageCer.map((rate) => `${(rate * 100).toFixed(2)}%`).join(" ");
    return `${result.status.padEnd(19)} ${result.id.padEnd(32)} CER/page: ${rates || "-"}${result.failures.length ? `\n${" ".repeat(20)}! ${result.failures.join("\n" + " ".repeat(22))}` : ""}`;
  });
  console.log(lines.join("\n"));
  console.log(`\nEnvironment: ${JSON.stringify(measurements.environment)}`);
  console.log(`Gate: ${gate.status}${gate.reasons.length ? `\n  - ${gate.reasons.join("\n  - ")}` : ""}`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "report.json"), `${JSON.stringify({ gate, environment: measurements.environment, results }, null, 2)}\n`);
  if (gate.status === "fail") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
