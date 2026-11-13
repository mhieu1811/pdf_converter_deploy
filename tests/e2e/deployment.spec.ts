import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { getFixture } from "../fixtures/manifest";

// These checks use only the public interface, so they run unchanged against a deployed preview:
//   BASE_URL=https://<preview-host> npm run test:e2e -- tests/e2e/deployment.spec.ts
const fixturePath = (id: string) => path.resolve(getFixture(id).pdfPath);
const READY = "Sẵn sàng. Chọn một tệp PDF.";
const DOCUMENT_PHRASES = ["Nguyễn Văn Mẫu", "SKH-VP", "Độc lập", "Kính gửi", "Thành phố Mẫu"];

function parseCsp(value: string | undefined): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of (value ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

test.describe("response headers and static assets", () => {
  test("the page is served with a restrictive Content Security Policy", async ({ request }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    const csp = parseCsp(response.headers()["content-security-policy"]);

    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("connect-src")).toEqual(["'self'"]);

    // Only the narrow WebAssembly permission; never general eval or inline scripts.
    const script = csp.get("script-src") ?? [];
    expect(script).toContain("'self'");
    expect(script).toContain("'wasm-unsafe-eval'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(csp.get("style-src")).not.toContain("'unsafe-inline'");

    // No external origin anywhere in the policy.
    for (const [name, sources] of csp) {
      for (const source of sources) expect(source, `${name} ${source}`).not.toMatch(/^(https?:|\*)/);
    }
  });

  test("other security headers are set", async ({ request }) => {
    const headers = (await request.get("/")).headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toContain("camera=()");
  });

  test("hashed build files are cached for a year and typed as scripts", async ({ request }) => {
    const html = await (await request.get("/")).text();
    const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(script, "index.html must reference a hashed script").toBeDefined();
    const response = await request.get(script!);
    expect(response.headers()["content-type"]).toMatch(/javascript/);
    expect(response.headers()["cache-control"]).toMatch(/max-age=31536000.*immutable/);
  });

  test("engine files have correct types and are revalidated", async ({ request }) => {
    const worker = await request.get("/engine/pdfjs/pdf.worker.min.mjs");
    expect(worker.status()).toBe(200);
    expect(worker.headers()["content-type"]).toMatch(/javascript/);
    expect(worker.headers()["cache-control"]).toContain("no-cache");

    const manifest = (await (await request.get("/engine/manifest.json")).json()) as { pdfjs: { wasm: string[] } };
    const wasm = await request.get(`/engine/pdfjs/wasm/${manifest.pdfjs.wasm[0]}`);
    expect(wasm.headers()["content-type"]).toContain("application/wasm");

    // The OCR model is a .gz file; whether a server also labels it with a content encoding is checked
    // by the real conversion below, which fails if the engine cannot read what it receives.
    const model = await request.get("/engine/tesseract/lang/vie.traineddata.gz");
    expect(model.status()).toBe(200);
    expect(model.headers()["content-type"]).not.toContain("text/html");
    expect((await model.body()).length).toBeGreaterThan(1_000_000);
  });

  test("a missing file is a 404, never an HTML page that engines could mistake for data", async ({ request }) => {
    for (const url of ["/engine/tesseract/lang/xxx.traineddata.gz", "/engine/pdfjs/nope.bcmap", "/assets/nope.js"]) {
      const response = await request.get(url);
      expect(response.status(), url).toBe(404);
    }
  });

  test("the page references no external script, style, font or form", async ({ page }) => {
    await page.goto("/");
    const external = await page.evaluate(() =>
      [...document.querySelectorAll("script[src], link[href], img[src], iframe, form")]
        .map((element) => ({ tag: element.tagName, url: element.getAttribute("src") ?? element.getAttribute("href") ?? "" }))
        .filter(({ tag, url }) => tag === "FORM" || tag === "IFRAME" || (!url.startsWith("blob:") && !url.startsWith("data:") && new URL(url, location.href).origin !== location.origin)),
    );
    expect(external).toEqual([]);
  });
});

async function openReady(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText(READY, { timeout: 60_000 });
}

async function convertThroughUi(page: Page, id: string) {
  await page.getByLabel("Chọn tệp PDF").setInputFiles(fixturePath(id));
  await page.getByRole("button", { name: "Chuyển sang Word" }).click();
  await expect(page.getByRole("link", { name: new RegExp(`${id}\\.docx`) })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Chọn tệp khác" }).click();
  await expect(page.getByRole("status")).toHaveText(READY);
}

test.describe("under the production policy", () => {
  test("engines start, native and scanned files convert with the network blocked, and nothing leaves the page", async ({ page, context, baseURL }) => {
    const violations: string[] = [];
    const consoleOutput: string[] = [];
    const requests: { url: string; afterReady: boolean }[] = [];
    let ready = false;

    await page.addInitScript(() => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const record = (text: string) => {
      consoleOutput.push(text);
      if (/Content Security Policy/i.test(text)) violations.push(text);
    };
    page.on("console", (message) => record(message.text()));
    page.on("pageerror", (error) => record(error.message));
    page.on("worker", (worker) => worker.on("console", (message) => record(message.text())));
    page.on("request", (request) => requests.push({ url: request.url(), afterReady: ready }));

    await openReady(page);
    ready = true;
    await context.setOffline(true);

    await convertThroughUi(page, "native-congvan-1p");
    await convertThroughUi(page, "scan-congvan-1p");

    violations.push(...(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)));
    expect(violations).toEqual([]);

    const origin = new URL(baseURL!).origin;
    const isLocal = (url: string) => url.startsWith("blob:") || url.startsWith("data:");
    for (const { url } of requests) {
      if (isLocal(url)) continue;
      expect(new URL(url).origin, url).toBe(origin);
      expect(url, url).not.toContain("/_vercel/");
    }
    expect(requests.filter((item) => item.afterReady && !isLocal(item.url)).map((item) => item.url)).toEqual([]);

    const storage = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      indexedDb: (await indexedDB.databases()).map((database) => database.name),
      caches: await caches.keys(),
      serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
    }));
    expect(storage).toEqual({ local: 0, session: 0, indexedDb: [], caches: [], serviceWorkers: 0 });
    expect(consoleOutput.filter((line) => DOCUMENT_PHRASES.some((phrase) => line.includes(phrase)))).toEqual([]);
  });

  test("a model file that fails to load is reported before any file can be chosen", async ({ page }) => {
    await page.route("**/engine/tesseract/lang/vie.traineddata.gz", (route) => route.fulfill({ status: 404, contentType: "text/html", body: "<html></html>" }));
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("Không tải được", { timeout: 60_000 });
    await expect(page.getByLabel("Chọn tệp PDF")).toBeDisabled();
  });

  test("the app does not register a service worker to fake offline support", async ({ page }) => {
    await openReady(page);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  });
});
