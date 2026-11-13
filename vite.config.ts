/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

/**
 * Applies the header rules of vercel.json in `vite preview`, so local tests run under the same
 * policy as the deployment. Like Vercel, every matching rule applies and later rules win.
 */
function vercelHeaders(): Plugin {
  const rules = (JSON.parse(readFileSync("vercel.json", "utf8")).headers as HeaderRule[]).map((rule) => ({
    pattern: new RegExp(`^${rule.source.replace(/\(\.\*\)/g, ".*")}$`),
    headers: rule.headers,
  }));
  return {
    name: "vercel-headers",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "/").split("?")[0];
        const wanted = new Map<string, string>();
        for (const rule of rules) {
          if (rule.pattern.test(pathname)) for (const { key, value } of rule.headers) wanted.set(key.toLowerCase(), value);
        }
        // The static file server sets its own headers (e.g. Cache-Control) when it writes the response; ours must win.
        const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => typeof response;
        response.writeHead = ((...args: unknown[]) => {
          for (const [key, value] of wanted) response.setHeader(key, value);
          for (const arg of args) {
            if (arg && typeof arg === "object" && !Array.isArray(arg)) {
              for (const name of Object.keys(arg)) if (wanted.has(name.toLowerCase())) delete (arg as Record<string, unknown>)[name];
            }
          }
          return writeHead(...args);
        }) as typeof response.writeHead;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), vercelHeaders()],
  // No single-page fallback: like the deployment, a missing file is a 404 rather than index.html.
  appType: "mpa",
  worker: { format: "es" },
  build: { target: "es2022" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
});
