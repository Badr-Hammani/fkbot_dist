/* Shared test harness for Weekend Wallet.
   The app itself has no build step and no dependencies — only these tests do.
   Everything here is deliberately small: boot a real browser against the real
   index.html, seed localStorage, drive it, and read what a user would see. */
"use strict";

const path = require("path");
const APP_DIR = path.resolve(__dirname, "..", "weekend-wallet");
const APP_URL = "file://" + path.join(APP_DIR, "index.html");

/* Intl.NumberFormat emits NON-BREAKING and NARROW-NO-BREAK spaces inside money
   strings. Comparing raw text against a normally-typed expectation produces
   failures that look identical on screen. Every comparison goes through this. */
function norm(v) {
  return String(v == null ? "" : v)
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- assertions ---------- */
class Check {
  constructor(name) {
    this.name = name;
    this.results = [];
    this.todos = [];
  }
  _push(ok, label, got, want) {
    this.results.push({ ok, label, got, want });
    return ok;
  }
  eq(label, got, want) {
    return this._push(norm(got) === norm(want), label, norm(got), norm(want));
  }
  /* number comparison with a cents-level tolerance */
  near(label, got, want, tol) {
    tol = tol == null ? 0.005 : tol;
    const ok = typeof got === "number" && Math.abs(got - want) <= tol;
    return this._push(ok, label, got, want);
  }
  ok(label, cond, detail) {
    return this._push(!!cond, label, detail == null ? !!cond : detail, true);
  }
  no(label, cond, detail) {
    return this._push(!cond, label, detail == null ? !!cond : detail, false);
  }
  has(label, haystack, needle) {
    return this._push(norm(haystack).includes(norm(needle)), label, norm(haystack), "…" + norm(needle) + "…");
  }
  /* A known, documented defect that is NOT yet fixed. Reported, never fails —
     so an open bug stays visible instead of being silently deleted. */
  todo(label, why) {
    this.todos.push({ label, why });
  }
}

/* ---------- app state ---------- */
/* A valid, empty-ish state. Suites override only what they care about, so a new
   field added to the app doesn't require touching every test. */
function baseState(over) {
  return Object.assign({
    setup: true,
    budget: 0,
    currency: "MAD",
    apiKey: "",
    geminiApiKey: "",
    scanProvider: "free",
    scanModel: "claude-opus-4-8",
    expenses: [],
    salary: 0,
    payday: 0,
    commitments: [],
    goals: [],
    swept: {},
    debts: [],
    restAmount: 0,
    restFrom: "",
    restTs: 0,
    cashTs: 0,
    backupTs: 0,
    nudgedAt: 0,
    lastCat: "",
    wkPlan: {},
    wkWeight: 2
  }, over || {});
}

function expense(over) {
  return Object.assign({
    id: "e" + Math.random().toString(36).slice(2, 8),
    ts: 1,
    amount: 100,
    cat: "food",
    note: "Test",
    date: "2026-08-18",
    photo: null
  }, over || {});
}

/* ---------- browser ---------- */
async function launch() {
  const { chromium } = require("playwright");
  return chromium.launch({
    executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"]
  });
}

/* Boot the real app with a seeded state at a frozen point in time.
   Returns a page plus small readers for the things tests assert on. */
async function boot(browser, state, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: opts.theme || "dark"
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    /* version.json can't be fetched over file:// — expected, not a failure */
    if (m.type() === "error" && !/version\.json|CORS|ERR_FAILED|Failed to load resource/.test(m.text())) {
      errors.push("console: " + m.text());
    }
  });

  await page.clock.setFixedTime(new Date(opts.now || "2026-08-18T09:00:00"));
  await page.goto(APP_URL);
  if (state) await page.evaluate(s => localStorage.setItem("weekend-wallet-v1", JSON.stringify(s)), state);
  await page.reload();
  await page.waitForTimeout(opts.settle || 350);

  const api = {
    page,
    ctx,
    errors,
    close: () => ctx.close(),
    stored: () => page.evaluate(() => JSON.parse(localStorage.getItem("weekend-wallet-v1") || "null")),
    raw: () => page.evaluate(() => localStorage.getItem("weekend-wallet-v1")),
    /* what the user actually sees */
    hero: () => page.evaluate(() => document.querySelector(".hero-amount") && document.querySelector(".hero-amount").textContent),
    heroCaption: () => page.evaluate(() => document.querySelector(".hero-caption") && document.querySelector(".hero-caption").textContent),
    todayLeft: () => page.evaluate(() => document.querySelector(".goal-amt") && document.querySelector(".goal-amt").textContent),
    poolLine: () => page.evaluate(() => {
      const l = [...document.querySelectorAll(".goal-pct")].map(e => e.textContent);
      return l.find(t => /left of your|past your/.test(t)) || "";
    }),
    footLines: () => page.evaluate(() => [...document.querySelectorAll(".goal-pct")].map(e => e.textContent.trim())),
    toast: () => page.evaluate(() => { const t = document.querySelector("#toast"); return t ? t.textContent : ""; }),
    shellText: () => page.evaluate(() => { const s = document.querySelector("#shell"); return s ? s.innerText : ""; }),
    shellSize: () => page.evaluate(() => { const s = document.querySelector("#shell"); return s ? s.innerHTML.length : 0; }),
    dayGroups: () => page.evaluate(() => [...document.querySelectorAll(".daygroup")].map(g => ({
      head: g.querySelector(".dayhead .micro").textContent,
      total: g.querySelector(".dayhead .total").textContent,
      rows: [...g.querySelectorAll(".exp")].map(r => r.textContent)
    }))),
    tab: async name => { await page.click('[data-tab="' + name + '"]'); await page.waitForTimeout(250); },
    /* the cash sheet arms a confirm on large differences — this makes the
       deliberate second tap so callers can assert on what was written */
    confirmTap: async sel => {
      await page.click(sel);
      await page.waitForTimeout(120);
      const label = norm(await page.evaluate(s => { const b = document.querySelector(s); return b ? b.textContent : ""; }, sel));
      if (/^Tap again/.test(label)) await page.click(sel);
      await page.waitForTimeout(300);
    }
  };
  return api;
}

/* Pure functions from scan.js, loadable without a browser. */
function scanLib() {
  delete require.cache[require.resolve(path.join(APP_DIR, "scan.js"))];
  return require(path.join(APP_DIR, "scan.js"));
}

module.exports = { APP_DIR, APP_URL, norm, Check, baseState, expense, launch, boot, scanLib };
