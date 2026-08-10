#!/usr/bin/env node
/**
 * Dashboard validation helper.
 *
 * Handles the boilerplate: starts wrangler dev, refreshes data from BigQuery,
 * provides a ready-to-use Playwright browser. The AGENT writes the actual
 * validation logic (which pages to visit, what interactions to perform,
 * which screenshots to take).
 *
 * Usage — the agent runs this as a library, not a CLI tool.
 * The agent writes a validation script per change, e.g.:
 *
 *   import { startDashboard, stopDashboard, getBrowser } from './validate.mjs';
 *
 *   await startDashboard();  // starts wrangler dev + BQ refresh
 *   const browser = await getBrowser();
 *   const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
 *
 *   // Navigate and take targeted screenshots
 *   await page.goto('http://localhost:8787/commercial/sales');
 *   await page.screenshot({ path: 'screenshots/sales-default.png', fullPage: true });
 *
 *   // Test a filter interaction
 *   await page.click('[data-filter="EMEA"]');
 *   await page.waitForTimeout(1000);
 *   await page.screenshot({ path: 'screenshots/sales-emea-filter.png', fullPage: true });
 *
 *   await stopDashboard();
 *
 * Can also be used as a CLI for simple full-page screenshots:
 *   node validate.mjs /commercial/sales /demandgen/overview
 *   node validate.mjs --all
 */

import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdir, writeFile, access } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || join(__dirname, "..", "screenshots");
const PORT = process.env.VALIDATE_PORT || 8787;
const WRANGLER_STARTUP_MS = 8000;

let _wrangler = null;
let _browser = null;

// ─── Library API ─────────────────────────────────────────────────────────────

/**
 * Start wrangler dev and refresh data from BigQuery.
 * Call this once at the start of validation.
 */
export async function startDashboard() {
  // Ensure .dev.vars exists
  try {
    await access(".dev.vars");
  } catch {
    if (process.env.BQ_SA_KEY) {
      await writeFile(".dev.vars", `BQ_SA_KEY=${process.env.BQ_SA_KEY}\nWEBHOOK_SECRET=validation\n`);
    } else {
      throw new Error("No .dev.vars and no BQ_SA_KEY env var.");
    }
  }

  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // Start wrangler dev
  console.log("[validate] Starting wrangler dev...");
  _wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });

  // Wait for ready
  let ready = false;
  const onData = (d) => {
    if (d.toString().includes("Ready on") || d.toString().includes("Listening on")) ready = true;
  };
  _wrangler.stdout.on("data", onData);
  _wrangler.stderr.on("data", onData);

  const start = Date.now();
  while (!ready && Date.now() - start < WRANGLER_STARTUP_MS) await sleep(500);
  await sleep(2000);

  // Refresh data from BigQuery
  console.log("[validate] Refreshing data from BigQuery...");
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/run-refresh-now`);
    const result = await resp.json();
    console.log(`[validate] Refresh: ${result.ok ? "✓" : "⚠"} (${result.updatedAt || "no timestamp"})`);
  } catch (e) {
    console.log(`[validate] Refresh failed: ${e.message} — continuing with cached/seed data`);
  }

  await sleep(3000);
  console.log("[validate] Dashboard ready at http://localhost:" + PORT);
}

/**
 * Get a Playwright browser instance. Reuses the same browser across calls.
 */
export async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({ args: ["--no-sandbox"] });
  }
  return _browser;
}

/**
 * Convenience: take a full-page screenshot of a route.
 */
export async function screenshot(route, filename) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);
  const filepath = join(SCREENSHOT_DIR, filename || route.replace(/\//g, "_").replace(/^_/, "") + ".png");
  await page.screenshot({ path: filepath, fullPage: true });
  await page.close();
  console.log(`[validate] Screenshot: ${filepath}`);
  return filepath;
}

/**
 * Get the base URL for the local dashboard.
 */
export function getBaseUrl() {
  return `http://localhost:${PORT}`;
}

/**
 * Get the screenshots directory path.
 */
export function getScreenshotDir() {
  return SCREENSHOT_DIR;
}

/**
 * Stop wrangler dev and close the browser.
 */
export async function stopDashboard() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
  if (_wrangler) {
    _wrangler.kill("SIGTERM");
    _wrangler = null;
  }
  console.log("[validate] Stopped.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── CLI mode (simple full-page screenshots) ─────────────────────────────────

const CORE_PAGES = [
  "/commercial/sales",
  "/commercial/ae-scorecard",
  "/commercial/demand-generation",
  "/demandgen/overview",
  "/okr",
  "/product-metrics",
  "/supply",
];

async function cli() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: node validate.mjs /page1 /page2 ...");
    console.error("       node validate.mjs --all");
    process.exit(1);
  }

  const pages = args[0] === "--all" ? CORE_PAGES : args;

  await startDashboard();

  console.log(`\nTaking screenshots of ${pages.length} pages...`);
  const results = [];
  for (const pagePath of pages) {
    try {
      const filepath = await screenshot(pagePath);
      results.push({ page: pagePath, file: filepath, status: "ok" });
    } catch (e) {
      results.push({ page: pagePath, status: "error", error: e.message });
      console.log(`  ✗ ${pagePath}: ${e.message}`);
    }
  }

  await stopDashboard();

  console.log("\n--- Validation Summary ---");
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "error");
  console.log(`✓ ${ok.length} screenshots taken`);
  if (failed.length) {
    console.log(`✗ ${failed.length} failed:`);
    for (const f of failed) console.log(`  - ${f.page}: ${f.error}`);
  }
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);

  process.exit(failed.length > 0 ? 1 : 0);
}

// Run CLI if called directly
if (process.argv[1] && process.argv[1].endsWith("validate.mjs") && process.argv.length > 2) {
  cli();
}
