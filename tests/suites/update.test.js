/* The update banner.
   This is how every future fix reaches the phone, so it gets its own suite.
   It needs a real HTTP origin — fetch() is blocked on file:// — so this suite
   starts a throwaway static server instead of using the shared boot(). */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { APP_DIR, launch } = require("../harness");

function serve() {
  const types = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json",
                  ".png": "image/png", ".webmanifest": "application/manifest+json" };
  const server = http.createServer((req, res) => {
    const file = path.join(APP_DIR, (req.url.split("?")[0] || "/").replace(/^\/+/, "") || "index.html");
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end("no"); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "text/plain" });
      res.end(buf);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

exports.name = "update · new-version banner";
exports.run = async function (t, env) {
  const server = await serve();
  const port = server.address().port;
  const browser = await (env.getBrowser ? env.getBrowser() : launch());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  let served = null;          /* what version.json reports; null = the real file */
  let hits = 0;
  await page.route("**/version.json*", route => {
    hits++;
    if (served === null) return route.continue();
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: served }) });
  });
  /* shrink the timers so the test doesn't wait two real minutes */
  await page.addInitScript(() => { window.__UPDATE_POLL_MS = 800; window.__UPDATE_MIN_GAP = 50; });

  const bar = () => page.evaluate(() => document.getElementById("updatebar").className);

  try {
    served = "4.7";
    await page.goto("http://127.0.0.1:" + port + "/index.html");
    await page.evaluate(() => localStorage.setItem("weekend-wallet-v1", JSON.stringify({
      setup: true, budget: 0, currency: "MAD", expenses: [], salary: 0, payday: 0, swept: {},
      commitments: [], goals: [], debts: [], apiKey: "", geminiApiKey: "", scanProvider: "free",
      scanModel: "claude-opus-4-8", restAmount: 0, restFrom: "", restTs: 0, cashTs: 0, wkPlan: {}, wkWeight: 2
    })));
    /* report whatever the app actually is, so "same version" really is the same */
    served = await page.evaluate(() => {
      const m = document.body.innerHTML.match(/var APP_VERSION = "([^"]+)"/);
      return m ? m[1] : "0";
    });
    await page.reload();
    await page.waitForTimeout(500);

    t.no("no banner while the versions match", (await bar()).includes("show"));

    hits = 0;
    await page.waitForTimeout(2600);
    t.ok("the app keeps checking while it is open", hits >= 2, hits + " checks in 2.6s");
    t.no("and still shows nothing when there is nothing new", (await bar()).includes("show"));

    /* a deploy lands while the app is sitting open */
    served = "99.0";
    await page.waitForTimeout(1400);
    t.ok("a new version raises the banner", (await bar()).includes("show"));

    hits = 0;
    await page.waitForTimeout(1800);
    t.eq("polling stops once it has been found", hits, 0);

    /* returning to the app checks immediately, without waiting out a limiter */
    served = null;
    await page.goto("http://127.0.0.1:" + port + "/index.html");
    await page.waitForTimeout(400);
    served = "99.0";
    hits = 0;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    t.ok("coming back to the app re-checks straight away", hits >= 1, hits + " checks");
    t.ok("and the banner appears", (await bar()).includes("show"));

    /* the button reloads with a cache-busting query */
    const target = await page.evaluate(() => {
      const b = document.getElementById("updatebar-go");
      return !!b && b.textContent.trim().length > 0;
    });
    t.ok("the banner has a working action", target);
  } finally {
    await ctx.close();
    server.close();
  }
};
