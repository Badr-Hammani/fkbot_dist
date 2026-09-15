/* Round-5 regressions.
   Every check here is a bug that shipped and that this suite did not catch.
   They share one theme: the app told Badr something that was not true —
   either two screens disagreeing about the same money in the same second, or
   a number that changed depending on the order he typed things in. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

/* pull the numbers the app itself is using, rather than re-deriving them */
const probe = p => p.evaluate(() => {
  const txt = s => { const e = document.querySelector(s); return e ? e.innerText : ""; };
  const bar = document.querySelector(".hero .meter-fill");
  return {
    hero: txt(".hero-amount"),
    caption: txt(".hero-caption"),
    barPct: bar ? parseFloat(bar.style.width) : null,
    barOver: bar ? bar.className.includes("over") : null,
    shell: txt("#shell")
  };
});

/* "spent X of Y" out of the caption, as rendered */
function captionSpend(caption) {
  const m = norm(caption).match(/spent\s+(?:[A-Z]{3}\s*)?([\d.,]+)\s+of\s+(?:[A-Z]{3}\s*)?([\d.,]+)/i);
  if (!m) return null;
  const n = s => parseFloat(s.replace(/[^\d.]/g, ""));
  return { spent: n(m[1]), of: n(m[2]) };
}

exports.name = "agreement · one budget, one answer";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- the meter must draw the two numbers the caption states ---- */
  {
    /* pool is in charge: 2,000 counted on the 15th, 5,000 already spent before
       that, 400 since. The bar used to be fed the whole month's spending and
       rendered a full red track directly under a green "1,600 left". */
    const app = await boot(browser, baseState({
      salary: 10000, payday: 1, restAmount: 2000, restFrom: "2026-08-15",
      restTs: new Date("2026-08-15T09:00:00").getTime(),
      expenses: [
        expense({ amount: 5000, date: "2026-08-05", ts: 1 }),
        expense({ amount: 400, date: "2026-08-16", ts: new Date("2026-08-16T10:00:00").getTime() })
      ]
    }), { now: "2026-08-18T09:00:00" });

    const r = await probe(app.page);
    const c = captionSpend(r.caption);
    t.ok("pool mode: the caption states a spend", !!c, r.caption);
    if (c) {
      const want = c.of > 0 ? Math.min(c.spent / c.of * 100, 100) : 0;
      t.near("the bar draws the spend the caption claims", r.barPct, want, 0.2);
      t.eq("and is only red when the caption says you are past it",
        r.barOver, c.spent > c.of);
    }
    t.has("the hero is the pool, not the plan", r.hero, "1,600");
    await app.close();
  }

  {
    /* plan mode: money handed to people is already subtracted from what the
       plan leaves, so adding it to the spent side too counted it twice */
    const app = await boot(browser, baseState({
      salary: 10000, payday: 1,
      debts: [{ id: "d1", name: "Sara", balance: -500, log: [
        { id: "l1", ts: new Date("2026-08-10T09:00:00").getTime(), amt: 500, dir: "r", note: "" }
      ] }],
      expenses: [expense({ amount: 1000, date: "2026-08-12", ts: 2 })]
    }), { now: "2026-08-18T09:00:00" });

    const r = await probe(app.page);
    const c = captionSpend(r.caption);
    t.ok("plan mode: the caption states a spend", !!c, r.caption);
    if (c) {
      const want = c.of > 0 ? Math.min(c.spent / c.of * 100, 100) : 0;
      t.near("the bar matches the caption here too", r.barPct, want, 0.2);
    }
    await app.close();
  }

  /* ---- Home and History → Months describe the same month ---- */
  {
    const app = await boot(browser, baseState({
      salary: 10000, payday: 1, restAmount: 2000, restFrom: "2026-08-15",
      restTs: new Date("2026-08-15T09:00:00").getTime(),
      expenses: [
        expense({ amount: 5000, date: "2026-08-05", ts: 1 }),
        expense({ amount: 500, date: "2026-08-16", ts: new Date("2026-08-16T10:00:00").getTime() })
      ]
    }), { now: "2026-08-18T09:00:00" });

    const home = norm(await app.hero());
    await app.tab("history");
    await app.page.click('[data-hist="months"]');
    await app.page.waitForTimeout(250);
    const months = norm(await app.shellText());
    t.has("the months card names the same number as Home", months, home);
    t.no("and does not quote the salary plan instead",
      /left of your .*10,?000 plan/.test(months), months.slice(0, 400));
    await app.close();
  }

  /* ---- the ledger means the same thing whatever order it was typed ---- */
  {
    const lent = { id: "a", ts: new Date("2026-08-10T09:00:00").getTime(), amt: 500, dir: "r", note: "" };
    const back = { id: "b", ts: new Date("2026-08-16T09:00:00").getTime(), amt: 500, dir: "b", note: "" };
    const read = async order => {
      const app = await boot(browser, baseState({
        salary: 9000, payday: 1, restAmount: 3000, restFrom: "2026-08-01",
        restTs: new Date("2026-08-01T09:00:00").getTime(),
        debts: [{ id: "d1", name: "Ahmed", balance: 0, log: order }]
      }), { now: "2026-08-18T09:00:00" });
      const out = { pool: norm(await app.poolLine()), today: norm(await app.todayLeft()) };
      await app.close();
      return out;
    };
    /* same two facts, typed the other way round */
    const chrono = await read([lent, back]);
    const jumbled = await read([back, lent]);
    t.eq("lending 500 and getting it back leaves the pool where it started",
      chrono.pool, jumbled.pool);
    t.eq("and the daily rate with it", chrono.today, jumbled.today);
    t.has("the pool is untouched by a round trip", chrono.pool, "3,000");
  }

  /* ---- a loan payment and its undo cancel out exactly ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [{ id: "c1", name: "Dad", kind: "loan", amount: 1000, due: 5,
                      remaining: 800, paid: {}, draws: [] }]
    }), { now: "2026-08-18T09:00:00" });

    const remaining = () => app.page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("weekend-wallet-v1"));
      return s.commitments[0].remaining;
    });

    await app.tab("plan");
    await app.page.click(".commitment-card");
    await app.page.waitForTimeout(300);

    /* leave "Actual amount paid" blank: its placeholder is the monthly 1,000,
       so one tap pays 1,000 against a balance of only 800 — the exact case
       that used to invent 200 of debt when undone */
    await app.page.click("#c-pay");
    await app.page.waitForTimeout(400);
    t.near("paying more than you owe clears the balance, no further",
      await remaining(), 0, 0.01);

    await app.page.click(".commitment-card");
    await app.page.waitForTimeout(300);
    await app.page.click("#c-unpay");
    await app.page.waitForTimeout(400);
    t.near("undoing it gives back exactly what it took — not the amount typed",
      await remaining(), 800, 0.01);
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- an unpaid bill still needs its money after the due day ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [{ id: "c1", name: "Rent", kind: "sub", amount: 2000, due: 5,
                      remaining: 0, paid: {}, draws: [] }]
    }), { now: "2026-08-18T09:00:00" });
    await app.tab("plan");
    await app.page.click("#p-cash");
    await app.page.waitForTimeout(350);
    const aside = await app.page.evaluate(() => document.querySelector("#sheet").innerText);
    t.has("rent that is overdue and unpaid is still money to set aside",
      aside, "2,000");
    t.no("and is not described as not yet due", /not due yet/i.test(norm(aside)), norm(aside).slice(0, 300));
    await app.close();
  }

  /* ---- the line stating your pool is readable on the phone it runs on ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1, restAmount: 2000, restFrom: "2026-08-15",
      restTs: new Date("2026-08-15T09:00:00").getTime(),
      expenses: [expense({ amount: 640, date: "2026-08-16", ts: new Date("2026-08-16T10:00:00").getTime() })]
    }), { now: "2026-08-18T09:00:00" });
    const clipped = await app.page.evaluate(() => {
      const e = [...document.querySelectorAll(".goal-pct")].find(x => /left of your|past your/.test(x.textContent));
      if (!e) return null;
      return { over: e.scrollWidth > e.clientWidth + 1, text: e.innerText };
    });
    t.ok("the pool line is present", !!clipped);
    if (clipped) t.no("and is not cut off at 390px", clipped.over, clipped.text);
    await app.close();
  }
};
