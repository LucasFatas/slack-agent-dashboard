#!/usr/bin/env node
/**
 * Dashboard visual validation helper.
 *
 * Handles ALL the cloud VM environment quirks so the agent only writes
 * validation logic (which pages to visit, what to click, what to screenshot).
 *
 * What this handles automatically:
 * - Finds Chromium (pre-installed at /opt/pw-browsers in cloud VMs)
 * - Starts wrangler dev as a child process (won't die when bash returns)
 * - Refreshes BigQuery data via /api/run-refresh-now
 * - Pre-fetches blocked CDN deps (Chart.js) via curl and intercepts in-browser
 * - Bypasses the HTTP proxy for localhost connections
 * - Uses NODE_EXTRA_CA_CERTS for BQ TLS in cloud VMs
 * - Polls for data load instead of fixed timeouts (handles 36MB+ responses)
 *
 * Library usage (agent writes this part):
 *   import { startDashboard, newPage, screenshot, waitForData, stopDashboard } from './validate.mjs';
 *   await startDashboard();            // handles everything above
 *   const page = await newPage();      // CDN interception + proxy bypass pre-configured
 *   await page.goto('http://localhost:8787/commercial/marketing/google');
 *   await waitForData(page);           // polls until tables/charts have data
 *   await page.screenshot({ path: 'screenshots/google.png', fullPage: true });
 *   await stopDashboard();
 *
 * CLI usage:
 *   node validate.mjs /commercial/sales /commercial/marketing
 *   node validate.mjs --all
 */

import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import { mkdir, writeFile, access, readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || join(__dirname, "..", "screenshots");
const CDN_CACHE_DIR = join(__dirname, ".cdn-cache");
const PORT = process.env.VALIDATE_PORT || 8787;
const WRANGLER_STARTUP_MS = 15000;
const DATA_POLL_MS = 30000;   // max time to wait for data to load on a page
const RENDER_SETTLE_MS = 2000; // time for charts to finish animating after data loads

let _wrangler = null;
let _browser = null;
let _cdnCache = {};

// CDN URLs the dashboards load that are blocked in the cloud VM.
// curl can reach these through the proxy; the browser cannot.
const CDN_DEPS = [
  "https://cdn.jsdelivr.net/npm/chart.js",
  "https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels",
  "https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation",
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
      execSync(`curl -sL -o "${cachePath}" "${url}"`, { timeout: 15000 });
      const data = await readFile(cachePath);
      if (data.length > 100) {  // sanity check — not a 403 error page
        _cdnCache[url] = data;
        console.log(`[validate] Cached CDN: ${url} (${(data.length / 1024).toFixed(0)}KB)`);
      }
    } catch {
      console.log(`[validate] Warning: couldn't fetch ${url}`);
    }
  }
}

async function setupPageInterception(page) {
  await page.route("**/*", async (route) => {
    const reqUrl = route.request().url();

    // Serve cached CDN deps
    for (const [cdnUrl, body] of Object.entries(_cdnCache)) {
      const cdnPath = new URL(cdnUrl).pathname;
      if (reqUrl.startsWith(cdnUrl) || reqUrl.includes(cdnPath)) {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body,
        });
        return;
      }
    }

    // Stub any remaining blocked CDN requests (prevent hangs)
    if (reqUrl.includes("cdn.jsdelivr.net") || reqUrl.includes("cdnjs.cloudflare.com") || reqUrl.includes("unpkg.com")) {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "/* blocked CDN - stubbed */",
      });
      return;
    }

    await route.continue();
  });
}

// ─── Chromium discovery ──────────────────────────────────────────────────────

function findChromium() {
  // Check PLAYWRIGHT_BROWSERS_PATH first (set in cloud VMs)
  const pwPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pwPath && existsSync(pwPath)) {
    try {
      const found = execSync(
        `find "${pwPath}" -type f \\( -name "chrome-headless-shell" -o -name "chromium" -o -name "chrome" \\) 2>/dev/null | head -1`,
        { encoding: "utf-8" }
      ).trim();
      if (found) return found;
    } catch {}
  }

  // Scan common cloud VM locations
  for (const dir of ["/opt/pw-browsers", "/opt/google", "/usr/bin"]) {
    if (!existsSync(dir)) continue;
    try {
      const found = execSync(
        `find "${dir}" -type f \\( -name "chrome-headless-shell" -o -name "chromium-browser" -o -name "chromium" -o -name "chrome" \\) 2>/dev/null | head -1`,
        { encoding: "utf-8" }
      ).trim();
      if (found) return found;
    } catch {}
  }

  // Fall back to PATH
  try {
    return execSync("which chromium-browser || which chromium || which google-chrome 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {}

  // Let Playwright try its default (works locally)
  return undefined;
}

// ─── Library API ─────────────────────────────────────────────────────────────

/**
 * Start wrangler dev and refresh data from BigQuery.
 * Must be called from the dashboard repo directory (product-metrics-dashboard).
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

  // Ensure dependencies installed
  if (!existsSync("node_modules")) {
    console.log("[validate] Installing dashboard dependencies...");
    try {
      execSync("npm install", { stdio: "pipe", timeout: 60000 });
    } catch (e) {
      console.log(`[validate] npm install warning: ${e.message}`);
    }
  }

  // Pre-fetch CDN deps
  await prefetchCdnDeps();

  // Build wrangler env — inherit everything + ensure CA certs for BQ TLS
  const wranglerEnv = { ...process.env, NODE_ENV: "development" };
  // Cloud VMs have a CA bundle at /root/.ccr/ca-bundle.crt
  if (existsSync("/root/.ccr/ca-bundle.crt") && !wranglerEnv.NODE_EXTRA_CA_CERTS) {
    wranglerEnv.NODE_EXTRA_CA_CERTS = "/root/.ccr/ca-bundle.crt";
  }

  // Start wrangler dev as a child process (stays alive within this Node process)
  console.log("[validate] Starting wrangler dev...");
  _wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: wranglerEnv,
    detached: false,  // dies with this process, not with bash
  });

  // Wait for ready signal
  let ready = false;
  const onData = (d) => {
    const s = d.toString();
    if (s.includes("Ready on") || s.includes("Listening on") || s.includes(`localhost:${PORT}`)) {
      ready = true;
    }
  };
  _wrangler.stdout.on("data", onData);
  _wrangler.stderr.on("data", onData);

  const start = Date.now();
  while (!ready && Date.now() - start < WRANGLER_STARTUP_MS) await sleep(500);

  // Verify wrangler is actually serving
  let serving = false;
  for (let i = 0; i < 5; i++) {
    try {
      const resp = await fetch(`http://localhost:${PORT}/healthz`);
      if (resp.ok) { serving = true; break; }
    } catch {}
    await sleep(1000);
  }
  if (!serving) console.log("[validate] Warning: wrangler may not be ready (healthz didn't respond)");

  // Refresh data from BigQuery
  console.log("[validate] Refreshing data from BigQuery...");
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/run-refresh-now`, { signal: AbortSignal.timeout(30000) });
    const result = await resp.json();
    console.log(`[validate] Refresh: ${result.ok ? "✓" : "⚠"} (${result.updatedAt || "no timestamp"})`);
  } catch (e) {
    console.log(`[validate] Refresh failed: ${e.message} — continuing with cached/seed data`);
  }

  await sleep(2000);
  console.log(`[validate] Dashboard ready at http://localhost:${PORT}`);
}

/**
 * Get a Playwright browser instance.
 */
export async function getBrowser() {
  if (!_browser) {
    const executablePath = findChromium();
    _browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--proxy-bypass-list=localhost,127.0.0.1",  // don't proxy localhost
      ],
      ...(executablePath ? { executablePath } : {}),
    });
    if (executablePath) console.log(`[validate] Using Chromium: ${executablePath}`);
  }
  return _browser;
}

/**
 * Create a new page with CDN interception and proxy bypass pre-configured.
 */
export async function newPage(opts) {
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    ...opts,
  });
  await setupPageInterception(page);
  return page;
}

/**
 * Wait for data to load on a page. Polls until tables have rows or charts
 * have rendered, up to DATA_POLL_MS. Use after page.goto().
 */
export async function waitForData(page, timeoutMs = DATA_POLL_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hasData = await page.evaluate(() => {
      // Check for table rows
      const tables = document.querySelectorAll("table tbody tr, .data-table tr");
      if (tables.length > 0) return true;
      // Check for Chart.js canvases that have been drawn
      const canvases = document.querySelectorAll("canvas");
      for (const c of canvases) {
        if (c.width > 0 && c.height > 0) return true;
      }
      // Check for metric values (KPI cards)
      const metrics = document.querySelectorAll(".metric-value, .kpi-value, .stat-value");
      for (const m of metrics) {
        if (m.textContent.trim() && m.textContent.trim() !== "-" && m.textContent.trim() !== "0") return true;
      }
      return false;
    });
    if (hasData) {
      await sleep(RENDER_SETTLE_MS);
      return true;
    }
    await sleep(500);
  }
  console.log("[validate] Warning: data didn't load within timeout");
  return false;
}

/**
 * Convenience: navigate to a route, wait for data, take a full-page screenshot.
 */
export async function screenshot(route, filename) {
  const page = await newPage();
  await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForData(page);
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
