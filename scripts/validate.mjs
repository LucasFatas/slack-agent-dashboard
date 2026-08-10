#!/usr/bin/env node
/**
 * Dashboard visual validation helper.
 *
 * Handles the boilerplate: starts wrangler dev, refreshes data from BigQuery,
 * pre-fetches CDN dependencies (Chart.js etc.) that the cloud VM can't reach,
 * provides a ready-to-use Playwright browser with CDN interception.
 *
 * The AGENT writes the actual validation logic per change.
 *
 * Library usage:
 *   import { startDashboard, newPage, screenshot, stopDashboard } from './validate.mjs';
 *   await startDashboard();
 *   const page = await newPage();
 *   await page.goto('http://localhost:8787/commercial/sales');
 *   await page.screenshot({ path: 'screenshots/sales.png', fullPage: true });
 *   await stopDashboard();
 *
 * CLI usage:
 *   node validate.mjs /commercial/sales /commercial/marketing
 *   node validate.mjs --all
 */

import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import { mkdir, writeFile, access, readFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || join(__dirname, "..", "screenshots");
const CDN_CACHE_DIR = join(__dirname, ".cdn-cache");
const PORT = process.env.VALIDATE_PORT || 8787;
const WRANGLER_STARTUP_MS = 10000;

let _wrangler = null;
let _browser = null;
let _cdnCache = {};  // url → Buffer

// CDN URLs the dashboards depend on that may be blocked in the cloud VM
const CDN_DEPS = [
  "https://cdn.jsdelivr.net/npm/chart.js",
  "https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels",
];

// ─── CDN pre-fetch ───────────────────────────────────────────────────────────

async function prefetchCdnDeps() {
  await mkdir(CDN_CACHE_DIR, { recursive: true });

  for (const url of CDN_DEPS) {
    const filename = url.replace(/[^a-zA-Z0-9.-]/g, "_");
    const cachePath = join(CDN_CACHE_DIR, filename);

    if (existsSync(cachePath)) {
      _cdnCache[url] = await readFile(cachePath);
      continue;
    }

    try {
      // curl works through the proxy; fetch in Node may not
      execSync(`curl -sL -o "${cachePath}" "${url}"`, { timeout: 15000 });
      _cdnCache[url] = await readFile(cachePath);
      console.log(`[validate] Cached CDN: ${url}`);
    } catch {
      console.log(`[validate] Warning: couldn't fetch ${url} — charts may not render`);
    }
  }
}

/**
 * Set up CDN interception on a Playwright page.
 * Intercepts requests to blocked CDN URLs and serves them from the local cache.
 */
async function setupCdnInterception(page) {
  if (Object.keys(_cdnCache).length === 0) return;

  await page.route("**/*", async (route) => {
    const reqUrl = route.request().url();

    // Check if this request matches a cached CDN URL
    for (const [cdnUrl, body] of Object.entries(_cdnCache)) {
      if (reqUrl.startsWith(cdnUrl) || reqUrl.includes(new URL(cdnUrl).pathname)) {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body,
        });
        return;
      }
    }

    await route.continue();
  });
}

// ─── Chromium discovery ──────────────────────────────────────────────────────

function findChromium() {
  // Cloud VMs may have Chromium at /opt/pw-browsers or a custom path
  const candidates = [
    "/opt/pw-browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
    "/opt/pw-browsers/chromium-headless-shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
    "/opt/pw-browsers/chromium",
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Fall back to Playwright's bundled browser (works locally)
  return undefined;
}

// ─── Library API ─────────────────────────────────────────────────────────────

/**
 * Start wrangler dev and refresh data from BigQuery.
 */
export async function startDashboard() {
  // Ensure .dev.vars exists
  try {
    await access(".dev.vars");
  } catch {
    if (process.env.BQ_SA_KEY) {
      console.log("[validate] Creating .dev.vars from BQ_SA_KEY env var...");
      await writeFile(".dev.vars", `BQ_SA_KEY=${process.env.BQ_SA_KEY}\nWEBHOOK_SECRET=validation\n`);
    } else {
      throw new Error("No .dev.vars and no BQ_SA_KEY env var.");
    }
  }

  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // Pre-fetch CDN deps (Chart.js etc.)
  await prefetchCdnDeps();

  // Start wrangler dev
  console.log("[validate] Starting wrangler dev...");
  _wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });

  let ready = false;
  const onData = (d) => {
    const s = d.toString();
    if (s.includes("Ready on") || s.includes("Listening on")) ready = true;
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
  console.log(`[validate] Dashboard ready at http://localhost:${PORT}`);
}

/**
 * Get a Playwright browser instance.
 */
export async function getBrowser() {
  if (!_browser) {
    const executablePath = findChromium();
    _browser = await chromium.launch({
      args: ["--no-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    });
    if (executablePath) console.log(`[validate] Using Chromium at ${executablePath}`);
  }
  return _browser;
}

/**
 * Create a new page with CDN interception already set up.
 * Use this instead of browser.newPage() directly.
 */
export async function newPage(opts) {
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    ...opts,
  });
  await setupCdnInterception(page);
  return page;
}

/**
 * Convenience: navigate to a route, wait for render, take a full-page screenshot.
 */
export async function screenshot(route, filename) {
  const page = await newPage();
  await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);
  const filepath = join(SCREENSHOT_DIR, filename || route.replace(/\//g, "_").replace(/^_/, "") + ".png");
  await page.screenshot({ path: filepath, fullPage: true });
  await page.close();
  console.log(`[validate] Screenshot: ${filepath}`);
  return filepath;
}

export function getBaseUrl() {
  return `http://localhost:${PORT}`;
}

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

// ─── CLI mode ────────────────────────────────────────────────────────────────

const CORE_PAGES = [
  "/commercial/sales",
  "/commercial/ae-scorecard",
  "/commercial/demand-generation",
  "/commercial/marketing",
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

if (process.argv[1] && process.argv[1].endsWith("validate.mjs") && process.argv.length > 2) {
  cli();
}
