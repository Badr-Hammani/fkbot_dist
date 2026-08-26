/* The financial engine: what's left, what you can spend today, month
   aggregation, and the date boundaries all of it depends on.
   Every number here is checked against what the user actually sees. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

exports.name = "money · budget engine & dates";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();
  const NOW = "2026-08-18T09:00:00";          /* Tuesday 18 August 2026 */

  /* ---------- salary plan ---------- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [{ id: "c1", name: "Loan", amount: 2500, kind: "loan", due: 3, remaining: 25000, paid: {} },
                    { id: "c2", name: "Netflix", amount: 65, kind: "sub", due: 12, remaining: 0, paid: {} }],
      goals: [{ id: "g1", name: "Trip", target: 8000, saved: 0, monthly: 800 }],
      expenses: [expense({ amount: 400, date: "2026-08-10" })]
    }), { now: NOW });

    /* 9000 − 2565 bills − 800 savings = 5635 spendable; minus 400 spent */
    t.eq("hero = plan minus spending", await app.hero(), "MAD 5,235");
    t.has("caption states the plan", await app.heroCaption(), "spent MAD 400 of MAD 5,635");
    t.no("no page errors on the salary path", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---------- bill paid above plan ---------- */
  {
    const app = await boot(browser, baseState({
      salary: 9000,
      commitments: [{ id: "c1", name: "Dad loan", amount: 2500, kind: "loan", due: 3, remaining: 25000,
                      paid: { "2026-08": { amt: 2770, ts: Date.parse("2026-08-03") } } }]
    }), { now: NOW });
    /* the real 2770 is used for this month, not the 2500 plan */
    t.eq("overpaid bill reduces spendable", await app.hero(), "MAD 6,230");
    await app.close();
  }

  /* ---------- rest-of-month pool ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-08-18", restTs: 1
    }), { now: NOW });
    /* 14 days left; 6 are weekend days; weight 2 → 8 + 12 = 20 units */
    t.eq("weekday rate = pool / weighted days", await app.todayLeft(), "MAD 50 left today");
    t.has("pool line shows what's left", await app.poolLine(), "MAD 1,000 left of your MAD 1,000");
    await app.close();
  }

  /* spending earlier in the week lowers the rate */
  {
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-08-17", restTs: 1,
      expenses: [expense({ amount: 450, date: "2026-08-17", cat: "out" })]
    }), { now: NOW });
    t.eq("rate drops after overspending", await app.todayLeft(), "MAD 27 left today");
    await app.close();
  }

  /* today's own spending must not shrink today's target */
  {
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-08-18", restTs: 1,
      expenses: [expense({ amount: 200, date: "2026-08-18", ts: Date.parse("2026-08-18T08:00:00") })]
    }), { now: NOW });
    t.has("today's target is fixed at midnight", await app.footLines().then(l => l.join(" ")), "of MAD 50");
    await app.close();
  }

  /* the pool anchors to a moment, not a day */
  {
    const app = await boot(browser, baseState({
      restAmount: 600, restFrom: "2026-08-18", restTs: Date.parse("2026-08-18T18:00:00"),
      expenses: [expense({ amount: 38, date: "2026-08-18", ts: Date.parse("2026-08-18T09:00:00") })]
    }), { now: "2026-08-18T19:00:00" });
    t.has("spending before the anchor isn't re-subtracted", await app.poolLine(), "MAD 600 left of your MAD 600");
    await app.close();
  }

  /* ---------- date boundaries ---------- */
  {
    /* last day of the month: one day left, not zero */
    const app = await boot(browser, baseState({ restAmount: 300, restFrom: "2026-08-31", restTs: 1 }),
      { now: "2026-08-31T09:00:00" });
    t.has("month end leaves exactly one day", await app.page.evaluate(() =>
      [...document.querySelectorAll(".sec")].map(s => s.textContent).join(" ")), "1 days left this month");
    await app.close();
  }
  {
    /* leap day exists and is spendable */
    const app = await boot(browser, baseState({
      restAmount: 290, restFrom: "2028-02-01", restTs: 1
    }), { now: "2028-02-01T09:00:00" });
    t.has("leap February has 29 days", await app.page.evaluate(() =>
      [...document.querySelectorAll(".sec")].map(s => s.textContent).join(" ")), "29 days left this month");
    await app.close();
  }
  {
    /* a pool set last month is retired, not carried into this one */
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-07-20", restTs: 1,
      expenses: [expense({ amount: 700, date: "2026-07-22" })]
    }), { now: NOW });
    t.ok("stale pool retired on load", await app.page.evaluate(() => !!document.querySelector("#h-newmonth")));
    t.no("no stale daily target survives the month turn", await app.page.evaluate(() =>
      [...document.querySelectorAll(".sec")].some(s => /days left this month/.test(s.textContent))));
    await app.close();
  }
  {
    /* year boundary */
    const app = await boot(browser, baseState({ restAmount: 310, restFrom: "2026-12-01", restTs: 1 }),
      { now: "2026-12-01T09:00:00" });
    t.has("December counts 31 days", await app.page.evaluate(() =>
      [...document.querySelectorAll(".sec")].map(s => s.textContent).join(" ")), "31 days left this month");
    await app.close();
  }

  /* ---------- month aggregation across screens ---------- */
  {
    const app = await boot(browser, baseState({
      salary: 9000,
      expenses: [expense({ amount: 300, date: "2026-08-05" }), expense({ amount: 200, date: "2026-08-18" }),
                 expense({ amount: 999, date: "2026-07-31" })],
      debts: [{ id: "d1", name: "Hamza", balance: -400,
                log: [{ ts: Date.parse("2026-08-16T10:00:00"), amt: 400, dir: "r", note: "" }] }]
    }), { now: NOW });
    const heroNow = norm(await app.hero());
    await app.tab("history");
    await app.page.click('[data-hist="months"]');
    await app.page.waitForTimeout(250);
    const card = await app.page.evaluate(() => {
      const c = document.querySelector(".wk");
      return { amt: c.querySelector(".wk-amt").textContent, subs: [...c.querySelectorAll(".wk-sub")].map(s => s.textContent) };
    });
    /* 500 spent this month + 400 handed to a person = 900 out of pocket */
    t.eq("month card counts money given to people", card.amt, "MAD 900");
    t.has("month card left figure matches Home", card.subs.join(" "), heroNow.replace("MAD ", "MAD "));
    t.no("July's 999 excluded from August", norm(card.amt).includes("999"));
    await app.close();
  }

  /* ---------- zero, negative and very large ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 500, restFrom: "2026-08-15", restTs: 1,
      expenses: [expense({ amount: 900, date: "2026-08-16", cat: "out" })]
    }), { now: NOW });
    t.has("overspent pool reads as past, not negative-left", await app.poolLine(), "past your MAD 500");
    await app.close();
  }
  {
    const app = await boot(browser, baseState({
      restAmount: 1e7, restFrom: "2026-08-18", restTs: 1
    }), { now: NOW });
    t.ok("very large pool renders without error", (await app.todayLeft() || "").length > 0);
    t.no("no page errors on large amounts", app.errors.length, app.errors.join(" | "));
    await app.close();
  }
  {
    const app = await boot(browser, baseState({}), { now: NOW });
    t.ok("empty state renders", (await app.shellSize()) > 500);
    t.no("no page errors on empty state", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---------- known-open defects, kept visible ---------- */
  t.todo("currency switch converts stored amounts",
    "P0: fmt() relabels without converting — needs a product decision on semantics");
};
