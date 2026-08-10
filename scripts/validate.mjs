#!/usr/bin/env node
/**
 * Dashboard visual validation script.
 *
 * Starts wrangler dev, refreshes data from BigQuery, and takes
 * Playwright screenshots of the specified dashboard pages.
 *
 * Usage:
 *   node validate.mjs /commercial/sales /demandgen/overview
 *   node validate.mjs --all   (screenshots a core set of pages)
 *
 * Prerequisites:
 *   - Run from the product-metrics-dashboard repo directory
 *   - .dev.vars must exist with BQ_SA_KEY (the script creates it from env if missing)
 *   - Playwright + Chromium installed (npx playwright install chromium --with-deps)
 *
 * Output:
 *   Screenshots saved to the directory specified by SCREENSHOT_DIR env var,
 *   or ./screenshots/ relative to THIS script's directory.
 */

import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdir, writeFile, access } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || join(__dirname, "..", "screenshots");
const PORT = 8787;
const WRANGLER_STARTUP_MS = 8000;
const BQ_REFRESH_MS = 15000;
const PAGE_RENDER_MS = 3000;

const CORE_PAGES = [
  "/commercial/sales",
  "/commercial/ae-scorecard",
  "/commercial/demand-generation",
  "/demandgen/overview",
  "/okr",
  "/product-metrics",
  "/supply",
];

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: node validate.mjs /page1 /page2 ...");
    console.error("       node validate.mjs --all");
    process.exit(1);
  }

  const pages = args[0] === "--all" ? CORE_PAGES : args;

  // Ensure .dev.vars exists (create from env if missing)
  try {
    await access(".dev.vars");
  } catch {
    if (process.env.BQ_SA_KEY) {
      console.log("Creating .dev.vars from BQ_SA_KEY env var...");
      await writeFile(".dev.vars", `BQ_SA_KEY=${process.env.BQ_SA_KEY}\nWEBHOOK_SECRET=validation\n`);
    } else {
      console.error("ERROR: No .dev.vars and no BQ_SA_KEY env var. Cannot start worker with data.");
      process.exit(1);
    }
  }

  // Create screenshot directory
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // Start wrangler dev
  console.log("Starting wrangler dev...");
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });

  // Log wrangler output for debugging
  let wranglerReady = false;
  wrangler.stdout.on("data", (d) => {
    const line = d.toString();
    if (line.includes("Ready on") || line.includes("Listening on")) {
      wranglerReady = true;
    }
  });
  wrangler.stderr.on("data", (d) => {
    const line = d.toString();
    if (line.includes("Ready on") || line.includes("Listening on")) {
      wranglerReady = true;
    }
  });

  // Wait for wrangler to start
  const startTime = Date.now();
  while (!wranglerReady && Date.now() - startTime < WRANGLER_STARTUP_MS) {
    await sleep(500);
  }
  if (!wranglerReady) {
    console.log("Wrangler didn't signal ready, proceeding anyway after timeout...");
  }

  // Extra buffer for stability
  await sleep(2000);

  // Trigger BigQuery refresh for real data
  console.log("Refreshing data from BigQuery...");
  try {
    const refreshResp = await fetch(`http://localhost:${PORT}/api/run-refresh-now`);
    const refreshResult = await refreshResp.json();
    if (refreshResult.ok) {
      console.log(`  ✓ Data refreshed (updatedAt: ${refreshResult.updatedAt})`);
    } else {
      console.log(`  ⚠ Refresh returned ok=false: ${JSON.stringify(refreshResult)}`);
      console.log("  Continuing with seed/cached data...");
    }
  } catch (e) {
    console.log(`  ⚠ Refresh failed: ${e.message}`);
    console.log("  Continuing with seed/cached data...");
  }

  // Wait for data to settle in KV
  await sleep(3000);

  // Take screenshots
  console.log(`\nTaking screenshots of ${pages.length} pages...`);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const results = [];

  for (const pagePath of pages) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const url = `http://localhost:${PORT}${pagePath}`;

    try {
      console.log(`  → ${pagePath}`);
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      // Wait for client-side rendering (charts, tables)
      await page.waitForTimeout(PAGE_RENDER_MS);

      const filename = pagePath.replace(/\//g, "_").replace(/^_/, "") + ".png";
      const filepath = join(SCREENSHOT_DIR, filename);
      await page.screenshot({ path: filepath, fullPage: true });

      results.push({ page: pagePath, file: filepath, status: "ok" });
      console.log(`    ✓ ${filename}`);
    } catch (e) {
      results.push({ page: pagePath, file: null, status: "error", error: e.message });
      console.log(`    ✗ ${e.message}`);
    }

    await page.close();
  }

  await browser.close();

  // Kill wrangler
  wrangler.kill("SIGTERM");

  // Summary
  console.log("\n--- Validation Summary ---");
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "error");
  console.log(`✓ ${ok.length} screenshots taken`);
  if (failed.length) {
    console.log(`✗ ${failed.length} failed:`);
    for (const f of failed) console.log(`  - ${f.page}: ${f.error}`);
  }
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);

  // Output file list for Claude to read
  console.log("\n--- Screenshot files ---");
  for (const r of ok) console.log(r.file);

  process.exit(failed.length > 0 ? 1 : 0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("Validation failed:", e);
  process.exit(1);
});
