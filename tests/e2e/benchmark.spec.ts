import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ConvertSummary } from "../../src/e2eHooks";
import { inspectDocx } from "../benchmark/docxInspect";
import type { Environment, MeasuredFixture } from "../benchmark/report";
import { FIXTURES } from "../fixtures/manifest";
import { fixtureBase64, openApp } from "./helpers";

const outDir = path.resolve(".test-artifacts");
const FULL_PAGE_PICTURE_SHARE = 0.6;

async function convert(page: Page, id: string, abortAfterMs?: number): Promise<ConvertSummary> {
  return page.evaluate(([data, name, options]) => window.__e2e!.convert(data, name, options), [fixtureBase64(id), `${id}.pdf`, { forceOcr: false, abortAfterMs }] as const);
}

test("measure every fixture with warm engines and the network blocked", async ({ browser }) => {
  test.setTimeout(30 * 60 * 1000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  let initialized = false;
  page.on("request", (request) => {
    if (initialized) requests.push(request.url());
  });
  await openApp(page);
  const initStart = Date.now();
  await page.evaluate(() => window.__e2e!.initialize());
  const coldInitMs = Date.now() - initStart;
  initialized = true;
  await context.setOffline(true);

  // Warm up the JIT and the OCR engine on small documents; they are not measured.
  await convert(page, "native-congvan-1p");
  await convert(page, "scan-congvan-1p");

  mkdirSync(path.join(outDir, "outputs"), { recursive: true });
  const measured: MeasuredFixture[] = [];
  let maxBlockMs = 0;
  for (const fixture of FIXTURES) {
    const before = requests.length;
    if (fixture.id === "perf-scan-5p") {
      await page.evaluate(() => {
        const state = { max: 0, last: performance.now() };
        (window as unknown as { __lag: typeof state & { timer?: number } }).__lag = state;
        (state as { timer?: number }).timer = window.setInterval(() => {
          const now = performance.now();
          state.max = Math.max(state.max, now - state.last - 50);
          state.last = now;
        }, 50);
      });
    }
    const result = await convert(page, fixture.id);
    if (fixture.id === "perf-scan-5p") {
      maxBlockMs = await page.evaluate(() => {
        const lag = (window as unknown as { __lag: { max: number; timer?: number } }).__lag;
        clearInterval(lag.timer);
        return lag.max;
      });
    }
    if (!result.ok) {
      measured.push({ id: fixture.id, outcome: "rejected", rejectCode: result.code, pages: [], editableTables: 0, emptyTableCells: 0, pictures: 0, rasterizedPages: 0, warnings: [], elapsedMs: 0, requestsAfterInit: requests.length - before });
      continue;
    }
    const bytes = Uint8Array.from(Buffer.from(result.base64, "base64"));
    writeFileSync(path.join(outDir, "outputs", `${fixture.id}.docx`), bytes);
    const { sections } = inspectDocx(bytes);
    measured.push({
      id: fixture.id,
      outcome: "converted",
      pages: sections.map((section) => ({ text: section.text })),
      editableTables: sections.reduce((sum, section) => sum + section.editableTables, 0),
      emptyTableCells: sections.reduce((sum, section) => sum + section.emptyBorderedCells, 0),
      pictures: sections.reduce((sum, section) => sum + section.pictures, 0),
      rasterizedPages: sections.filter((section) => section.pictureShare >= FULL_PAGE_PICTURE_SHARE).length,
      warnings: result.warnings,
      elapsedMs: result.elapsedMs,
      requestsAfterInit: requests.length - before,
    });
  }
  const heapMb = await page.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20);
  await page.evaluate(() => window.__e2e!.dispose());
  await context.close();

  // Cancellation is acknowledged quickly: abort a five-page scan while it is being recognized.
  const cancelContext = await browser.newContext();
  const cancelPage = await cancelContext.newPage();
  await openApp(cancelPage);
  await cancelPage.evaluate(() => window.__e2e!.initialize());
  const cancelled = await convert(cancelPage, "perf-scan-5p", 1500);
  await cancelContext.close();
  expect(cancelled.ok).toBe(false);

  const cpus = os.cpus();
  const environment: Environment = {
    browser: `Chromium ${browser.version()}`,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus[0]?.model ?? "unknown",
    cores: cpus.length,
    ramGb: os.totalmem() / 2 ** 30,
    coldInitMs,
  };
  const abortLatencyMs = !cancelled.ok ? cancelled.abortLatencyMs : undefined;
  mkdirSync(path.join(outDir, "benchmark"), { recursive: true });
  writeFileSync(
    path.join(outDir, "benchmark", "measurements.json"),
    `${JSON.stringify({ environment, fixtures: measured, responsiveness: { maxMainThreadBlockMs: maxBlockMs, abortLatencyMs }, memory: { jsHeapMbAfterAll: heapMb } }, null, 2)}\n`,
  );
  console.log(`cold init ${coldInitMs} ms; max main-thread block during the scan ${maxBlockMs.toFixed(0)} ms; cancel acknowledged in ${abortLatencyMs?.toFixed(0)} ms`);

  // The UI stays interactive (no freeze of a second or more) and cancellation is acknowledged within a second.
  expect(maxBlockMs).toBeLessThan(1000);
  expect(abortLatencyMs).toBeDefined();
  expect(abortLatencyMs!).toBeLessThan(1000);
  expect(measured.length).toBe(FIXTURES.length);
});
