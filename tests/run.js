#!/usr/bin/env node
/* Test runner for Weekend Wallet.
   Usage:  node tests/run.js            all suites
           node tests/run.js money      only suites whose name contains "money"
   Exits non-zero if any check fails, so it can gate a commit or CI. */
"use strict";

const fs = require("fs");
const path = require("path");
const { launch, Check } = require("./harness");

const SUITE_DIR = path.join(__dirname, "suites");
const filter = process.argv[2];

const C = process.stdout.isTTY
  ? { g: s => "[32m" + s + "[0m", r: s => "[31m" + s + "[0m",
      y: s => "[33m" + s + "[0m", d: s => "[90m" + s + "[0m",
      b: s => "[1m" + s + "[0m" }
  : { g: s => s, r: s => s, y: s => s, d: s => s, b: s => s };

(async () => {
  const files = fs.readdirSync(SUITE_DIR)
    .filter(f => f.endsWith(".test.js"))
    .filter(f => !filter || f.includes(filter))
    .sort();

  if (!files.length) {
    console.error("No suites matched " + (filter || "(none)"));
    process.exit(1);
  }

  /* One browser for every suite that needs it — launching per suite is the
     slowest thing in the run by a wide margin. */
  let browser = null;
  const getBrowser = async () => (browser = browser || await launch());

  let pass = 0, fail = 0, todo = 0;
  const failures = [];
  const started = Date.now();

  for (const file of files) {
    const suite = require(path.join(SUITE_DIR, file));
    const name = suite.name || file.replace(/\.test\.js$/, "");
    const check = new Check(name);
    process.stdout.write(C.b(name) + "\n");

    try {
      await suite.run(check, { getBrowser });
    } catch (err) {
      check.ok("suite threw: " + err.message, false, String(err && err.stack || err).split("\n").slice(0, 3).join(" | "));
    }

    for (const r of check.results) {
      if (r.ok) { pass++; process.stdout.write(C.d("  ok   ") + r.label + "\n"); }
      else {
        fail++;
        failures.push({ suite: name, ...r });
        process.stdout.write(C.r("  FAIL ") + r.label + "\n"
          + C.d("         got  ") + r.got + "\n"
          + C.d("         want ") + r.want + "\n");
      }
    }
    for (const t of check.todos) {
      todo++;
      process.stdout.write(C.y("  todo ") + t.label + C.d("  — " + t.why) + "\n");
    }
  }

  if (browser) await browser.close();

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  if (fail) {
    console.log(C.r(C.b(fail + " failing")) + ", " + pass + " passing"
      + (todo ? ", " + todo + " known-open" : "") + C.d("  (" + secs + "s)"));
    console.log("");
    for (const f of failures) console.log(C.r("  ✗ ") + f.suite + " › " + f.label);
    process.exit(1);
  }
  console.log(C.g(C.b(pass + " passing")) + (todo ? ", " + C.y(todo + " known-open") : "") + C.d("  (" + secs + "s)"));
  process.exit(0);
})().catch(err => {
  console.error("runner crashed:", err);
  process.exit(1);
});
