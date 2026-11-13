import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { ConvertSummary } from "../../src/e2eHooks";
import { inspectDocx } from "../benchmark/docxInspect";
import { fixtureBase64, openApp } from "./helpers";

// Distinctive text from the synthetic documents; none of it may appear in console output.
const DOCUMENT_PHRASES = ["Nguyễn Văn Mẫu", "SKH-VP", "Độc lập", "Kính gửi", "Tổng thu ngân sách", "1.254,7", "Thành phố Mẫu", "KIỂM TRA HIỂN THỊ", "THÔNG BÁO"];

async function convert(page: Page, id: string, abortAfterMs?: number): Promise<ConvertSummary> {
  return page.evaluate(([data, name, options]) => window.__e2e!.convert(data, name, options), [fixtureBase64(id), `${id}.pdf`, { forceOcr: false, abortAfterMs }] as const);
}

async function storageState(page: Page) {
  return page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    indexedDb: (await indexedDB.databases()).map((database) => database.name),
    caches: await caches.keys(),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
}

test.describe("documents never leave the browser", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;
  let initialized = false;
  const requestsAfterInit: string[] = [];
  const consoleOutput: string[] = [];

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    page.on("request", (request) => {
      if (initialized) requestsAfterInit.push(`${request.method()} ${request.url()}`);
    });
    page.on("console", (message) => consoleOutput.push(message.text()));
    page.on("pageerror", (error) => consoleOutput.push(error.message));
    await openApp(page);
    await page.evaluate(() => window.__e2e!.initialize());
    initialized = true;
    await page.evaluate(() => performance.mark("engines-ready"));
    await context.setOffline(true);
  });

  test.afterAll(async () => {
    await page.evaluate(() => window.__e2e!.dispose()).catch(() => undefined);
    await context.close();
  });

  test("conversion of native, scanned and mixed documents sends and stores nothing", async () => {
    for (const id of ["native-congvan-1p", "native-table-1p", "scan-congvan-1p", "scan-table-1p", "mixed-bad-text-layer"]) {
      const result = await convert(page, id);
      expect(result.ok, id).toBe(true);
      if (!result.ok) continue;
      const { files } = inspectDocx(Uint8Array.from(Buffer.from(result.base64, "base64")));
      for (const name of Object.keys(files).filter((file) => file.endsWith(".rels"))) {
        expect(Buffer.from(files[name]).toString("utf8"), `${id} ${name}`).not.toContain("TargetMode");
      }
      expect(Object.keys(files).some((name) => /vba|macro/i.test(name))).toBe(false);
    }
  });

  test("errors and refusals send and store nothing either", async () => {
    for (const id of ["invalid-not-pdf", "invalid-corrupt", "protected-pdf", "limit-pages-21", "limit-size-over", "scan-unreadable-1p"]) {
      expect((await convert(page, id)).ok, id).toBe(false);
    }
  });

  test("cancelling between pages sends and stores nothing", async () => {
    expect(await convert(page, "perf-native-10p", 0)).toMatchObject({ ok: false, code: "ABORTED" });
  });

  test("no request was made after initialization, by the page or by any worker", async () => {
    expect(requestsAfterInit).toEqual([]);
    const lateResources = await page.evaluate(() => {
      const ready = performance.getEntriesByName("engines-ready", "mark")[0].startTime;
      return performance.getEntriesByType("resource").filter((entry) => entry.startTime > ready && !entry.name.startsWith("blob:") && !entry.name.startsWith("data:")).map((entry) => entry.name);
    });
    expect(lateResources).toEqual([]);
  });

  test("nothing about the documents is persisted in the browser", async () => {
    expect(await storageState(page)).toEqual({ local: 0, session: 0, indexedDb: [], caches: [], serviceWorkers: 0 });
  });

  test("document text never reaches the console", async () => {
    const leaked = consoleOutput.filter((line) => DOCUMENT_PHRASES.some((phrase) => line.includes(phrase)));
    expect(leaked).toEqual([]);
  });
});

test("cancelling a running OCR sends and stores nothing", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  const output: string[] = [];
  let initialized = false;
  page.on("request", (request) => {
    if (initialized) requests.push(request.url());
  });
  page.on("console", (message) => output.push(message.text()));
  await openApp(page);
  await page.evaluate(() => window.__e2e!.initialize());
  initialized = true;
  await context.setOffline(true);
  expect(await convert(page, "perf-scan-5p", 400)).toMatchObject({ ok: false, code: "ABORTED" });
  expect(requests).toEqual([]);
  expect(await storageState(page)).toEqual({ local: 0, session: 0, indexedDb: [], caches: [], serviceWorkers: 0 });
  expect(output.filter((line) => DOCUMENT_PHRASES.some((phrase) => line.includes(phrase)))).toEqual([]);
  await context.close();
});
