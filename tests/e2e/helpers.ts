import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { getFixture } from "../fixtures/manifest";
import type { AnalyzeResult } from "../../src/e2eHooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const fixtureBase64 = (id: string): string =>
  readFileSync(path.join(root, getFixture(id).pdfPath)).toString("base64");

export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__e2e));
}

export async function analyzeFixture(page: Page, id: string): Promise<AnalyzeResult> {
  const base64 = fixtureBase64(id);
  return page.evaluate(([data, name]) => window.__e2e!.analyze(data, name), [base64, `${id}.pdf`] as const);
}

export const normalizeText = (text: string): string => text.normalize("NFC").replace(/\s+/g, " ").trim();
