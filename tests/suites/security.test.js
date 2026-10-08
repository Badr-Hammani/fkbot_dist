/* Security regressions.
   There is no server and no other user here, so the whole threat model is
   "content the app stores turns into markup or script". The realistic carrier
   is a backup file: people send those to themselves, and the app will load one
   from anywhere. Every field a backup can set is treated as hostile. */
"use strict";
const { boot, baseState, expense } = require("../harness");

exports.name = "security · stored XSS & secret handling";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();
  const NOW = "2026-08-18T09:00:00";

  /* Boot with a hostile field and report whether script ran anywhere. */
  async function attack(label, state, after) {
    const app = await boot(browser, state, { now: NOW });
    let fired = false;
    app.page.on("dialog", async d => { fired = true; await d.dismiss().catch(() => {}); });
    await app.page.evaluate(() => { window.__pwned = false; });
    if (after) await after(app);
    await app.page.waitForTimeout(400);
    const flagged = await app.page.evaluate(() => window.__pwned === true).catch(() => false);
    const html = await app.page.evaluate(() => document.querySelector("#shell").innerHTML);
    await app.close();
    return { fired, flagged, html, label };
  }

  const PAYLOAD_IMG = 'x" onerror="window.__pwned=true" data-a="';
  const PAYLOAD_TAG = '"><img src=x onerror="window.__pwned=true">';

  /* ---------- the photo field ---------- */
  {
    const r = await attack("photo", baseState({
      expenses: [expense({ id: "x", amount: 10, note: "hi", photo: PAYLOAD_IMG })]
    }));
    t.no("photo field does not execute script (list row)", r.fired || r.flagged);
    t.no("photo field does not inject an event handler", /onerror=/i.test(r.html), r.html.slice(0, 160));
  }

  /* the same field, on the detail screen and the edit preview */
  {
    const r = await attack("photo-detail", baseState({
      expenses: [expense({ id: "x", amount: 10, note: "hi", photo: PAYLOAD_IMG })]
    }), async app => {
      await app.page.click('[data-exp="x"]').catch(() => {});
      await app.page.waitForTimeout(400);
    });
    t.no("photo field is safe on the detail sheet", r.fired || r.flagged);
  }

  /* a non-image scheme must never reach an img src */
  {
    const r = await attack("photo-scheme", baseState({
      expenses: [expense({ id: "x", photo: "javascript:window.__pwned=true" })]
    }));
    t.no("javascript: URLs are not honoured", r.fired || r.flagged);
    t.no("javascript: never reaches the markup", /javascript:/i.test(r.html), r.html.slice(0, 160));
  }

  /* ---------- text fields ---------- */
  {
    const r = await attack("note", baseState({
      expenses: [expense({ id: "x", note: PAYLOAD_TAG })]
    }));
    t.no("expense note is escaped", r.fired || r.flagged);
  }
  {
    const r = await attack("person", baseState({
      debts: [{ id: "d1", name: PAYLOAD_TAG, balance: -100,
                log: [{ ts: Date.parse("2026-08-10"), amt: 100, dir: "r", note: PAYLOAD_TAG }] }]
    }));
    t.no("person name is escaped", r.fired || r.flagged);
  }
  {
    const r = await attack("commitment", baseState({
      salary: 9000,
      commitments: [{ id: "c1", name: PAYLOAD_TAG, amount: 100, kind: "sub", due: 20, remaining: 0, paid: {} }]
    }), async app => { await app.tab("plan"); });
    t.no("bill name is escaped", r.fired || r.flagged);
  }
  {
    const r = await attack("goal", baseState({
      goals: [{ id: "g1", name: PAYLOAD_TAG, target: 100, saved: 10, monthly: 0 }]
    }), async app => { await app.tab("plan"); });
    t.no("goal name is escaped", r.fired || r.flagged);
  }
  {
    /* category ids come from a fixed list, but a backup can set anything */
    const r = await attack("category", baseState({
      expenses: [expense({ id: "x", cat: PAYLOAD_TAG })]
    }));
    t.no("unknown category id is safe", r.fired || r.flagged);
  }

  /* ---------- the same payloads arriving through a real import ---------- */
  {
    const app = await boot(browser, baseState({}), { now: NOW });
    let fired = false;
    app.page.on("dialog", async d => { fired = true; await d.dismiss().catch(() => {}); });
    await app.page.evaluate(() => { window.__pwned = false; });
    await app.tab("settings");
    await app.page.setInputFiles("#s-import-file", {
      name: "hostile.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({
        currency: "MAD",
        expenses: [{ id: "x", ts: 1, amount: 10, cat: "food", note: PAYLOAD_TAG,
                     date: "2026-08-18", photo: PAYLOAD_IMG }]
      }))
    });
    await app.page.waitForTimeout(700);
    await app.tab("home");
    const flagged = await app.page.evaluate(() => window.__pwned === true).catch(() => false);
    t.no("a hostile backup cannot execute script", fired || flagged);
    t.no("and its payload is not stored raw as a photo",
      ((await app.stored()).expenses[0] || {}).photo === PAYLOAD_IMG);
    await app.close();
  }

  /* ---------- secrets ---------- */
  {
    const app = await boot(browser, baseState({ apiKey: "sk-ant-SECRET", geminiApiKey: "AIzaSECRET" }), { now: NOW });
    await app.tab("settings");
    const html = await app.page.evaluate(() => document.querySelector("#shell").innerHTML);
    /* keys are rendered into password inputs, which is the most that can be
       done client-side — but they must at least never leak into plain markup */
    t.ok("key inputs are type=password", /id="s-claude-key" type="password"/.test(html) || /type="password"[^>]*id="s-claude-key"/.test(html));
    t.no("no page errors on the settings screen", app.errors.length, app.errors.join(" | "));
    await app.close();
  }
};
