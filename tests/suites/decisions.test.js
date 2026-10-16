/* The two rules the owner chose in v8.4, pinned down.
   These are product decisions, not derivations — if a future change reverses
   one, that must be a deliberate choice made again, not a quiet drift. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

const NOW = "2026-08-18T09:00:00";
const ANCHOR = Date.parse("2026-08-01T00:00:00");
const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem("weekend-wallet-v1")));

exports.name = "decisions · borrowed cash is cash, goals move money";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---------- RULE 1: borrowed cash is cash ---------- */
  {
    /* symmetric: what comes in raises, what goes out lowers, so a round trip
       nets to nothing. The old rule counted only the way out and drained you. */
    const cases = [
      { name: "borrow only", log: [{ ts: Date.parse("2026-08-05T10:00:00"), amt: 500, dir: "b" }], want: 3500 },
      { name: "borrow then repay", log: [
          { ts: Date.parse("2026-08-05T10:00:00"), amt: 500, dir: "b" },
          { ts: Date.parse("2026-08-06T10:00:00"), amt: 500, dir: "r" }], want: 3000 },
      { name: "lend only", log: [{ ts: Date.parse("2026-08-05T10:00:00"), amt: 500, dir: "r" }], want: 2500 },
      { name: "lend then repaid", log: [
          { ts: Date.parse("2026-08-05T10:00:00"), amt: 500, dir: "r" },
          { ts: Date.parse("2026-08-06T10:00:00"), amt: 500, dir: "b" }], want: 3000 }
    ];
    for (const c of cases) {
      const app = await boot(browser, baseState({
        restAmount: 3000, restFrom: "2026-08-01", restTs: ANCHOR,
        debts: [{ id: "p1", name: "Ahmed", balance: 0,
          log: c.log.map((l, i) => Object.assign({ id: "l" + i, note: "" }, l)) }]
      }), { now: NOW });
      t.has(c.name + " leaves the pool at " + c.want,
        await app.poolLine(), "MAD " + c.want.toLocaleString("en-US"));
      await app.close();
    }
  }

  {
    /* money borrowed BEFORE you counted is already in the notes you counted,
       so it must not be added a second time */
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-01", restTs: ANCHOR,
      debts: [{ id: "p1", name: "Dad", balance: 900, log: [
        { id: "l1", ts: Date.parse("2026-07-20T10:00:00"), amt: 900, dir: "b", note: "" }] }]
    }), { now: NOW });
    t.has("borrowing from before the count is already in it",
      await app.poolLine(), "MAD 3,000 left of your MAD 3,000");
    await app.close();
  }

  {
    /* the denominator has to be the money you actually had, or the line
       fails its own arithmetic */
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-01", restTs: ANCHOR,
      debts: [{ id: "dad", name: "Dad", balance: 1800, log: [
        { id: "l1", ts: Date.parse("2026-08-06T10:00:00"), amt: 1800, dir: "b", note: "" }] }],
      expenses: [expense({ amount: 5850, date: "2026-08-10", cat: "out" })]
    }), { now: NOW });
    const line = norm(await app.poolLine());
    t.has("spent 5,850 of 4,800 is 1,050 short", line, "MAD 1,050 past your MAD 4,800");
    const txt = norm(await app.page.evaluate(() => {
      const s = document.querySelector(".suggest"); return s ? s.textContent : "";
    }));
    t.has("and the offer never claims that gap is covered", txt, "MAD 1,050 has no funding source recorded");
    await app.close();
  }

  /* ---------- RULE 2: goals move real money ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 2000, restFrom: "2026-08-01", restTs: ANCHOR,
      goals: [{ id: "g1", name: "Trip", target: 5000, saved: 0, monthly: 0, contributions: [] }]
    }), { now: NOW });

    t.has("the pool starts where it was counted", await app.poolLine(), "MAD 2,000 left of your MAD 2,000");

    await app.tab("plan");
    await app.page.click('[data-goal-money="g1"]').catch(async () => {
      /* fall back to whatever control opens the add-money sheet */
      await app.page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find(x => /add money/i.test(x.textContent));
        if (b) b.click();
      });
    });
    await app.page.waitForTimeout(350);
    await app.page.fill("#gm-amount", "800");
    await app.page.click("#gm-save");
    await app.page.waitForTimeout(450);

    const s = await stored(app.page);
    const g = s.goals[0];
    t.near("the goal records it", g.saved, 800, 0.01);
    t.eq("as a dated contribution", (g.contributions || []).length, 1);

    await app.tab("home");
    t.has("and it really leaves what you can spend",
      await app.poolLine(), "MAD 1,200 left of your MAD 1,200");
    t.no("no page errors", app.errors.length, app.errors.join(" | "));

    /* and it is reversible, like every other money move in the app */
    await app.tab("plan");
    await app.page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(x => /add money/i.test(x.textContent));
      if (b) b.click();
    });
    await app.page.waitForTimeout(350);
    await app.page.fill("#gm-amount", "200");
    await app.page.click("#gm-save");
    await app.page.waitForTimeout(300);
    await app.page.click("#toast button");
    await app.page.waitForTimeout(400);
    const s2 = await stored(app.page);
    t.near("undoing a contribution puts the money back", s2.goals[0].saved, 800, 0.01);
    t.eq("and removes the record", (s2.goals[0].contributions || []).length, 1);
    await app.close();
  }

  {
    /* the plan must not reserve the planned figure AND the real one */
    const app = await boot(browser, baseState({
      salary: 10000, payday: 1,
      goals: [{ id: "g1", name: "Trip", target: 5000, saved: 0, monthly: 1000,
                contributions: [{ id: "c1", ts: Date.parse("2026-08-05T10:00:00"), date: "2026-08-05", amt: 1500 }] }]
    }), { now: NOW });
    const shell = norm(await app.shellText());
    t.has("once you have put money in, the plan reserves what you actually put",
      shell, "MAD 8,500");
    t.no("not the planned figure as well", /MAD 7,500/.test(shell), shell.slice(0, 300));
    await app.close();
  }

  {
    /* putting money away must never RELEASE money: returning the actual
       figure the moment anything went in meant 100 into a goal planned at
       500 handed back the other 400 */
    const app = await boot(browser, baseState({
      salary: 8000, payday: 1,
      goals: [{ id: "g1", name: "Trip", target: 5000, saved: 0, monthly: 500, contributions: [] }]
    }), { now: NOW });
    const before = norm(await app.hero());
    await app.tab("plan");
    await app.page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(x => /add money/i.test(x.textContent));
      if (b) b.click();
    });
    await app.page.waitForTimeout(350);
    await app.page.fill("#gm-amount", "100");
    await app.page.click("#gm-save");
    await app.page.waitForTimeout(450);
    await app.tab("home");
    t.eq("saving part of what you planned changes nothing", norm(await app.hero()), before);
    await app.close();
  }

  {
    /* the pool is the money you counted; spending that happened BEFORE you
       counted is already missing from it and must not be charged again */
    const app = await boot(browser, baseState({
      restAmount: 1400, restFrom: "2026-08-18",
      restTs: Date.parse("2026-08-18T18:00:00"),
      expenses: [expense({ amount: 400, date: "2026-08-18", ts: Date.parse("2026-08-18T08:00:00") })]
    }), { now: "2026-08-18T19:00:00" });
    t.has("counting at six ignores what you spent at eight", await app.poolLine(), "MAD 1,400 left of your MAD 1,400");
    t.has("and the day starts whole, not already over", await app.todayLeft(), "MAD 100 left today");
    await app.close();
  }

  {
    /* you cannot restart a pool with money you have already spent */
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-10",
      restTs: Date.parse("2026-08-10T09:00:00"),
      expenses: [expense({ amount: 3200, date: "2026-08-12" })]
    }), { now: NOW });
    await app.tab("plan");
    await app.page.click("#p-rest-reset");
    await app.page.waitForTimeout(400);
    const s = await stored(app.page);
    t.eq("restarting while over does not move the start date", s.restFrom, "2026-08-10");
    t.has("it asks you to count what is really there", await app.toast(), "count what you have now");
    t.ok("and opens the cash check so you can", await app.page.evaluate(
      () => document.querySelector("#sheet").classList.contains("show")));
    await app.page.evaluate(() => { const x = document.querySelector(".sheet-x"); if (x) x.click(); });
    await app.page.waitForTimeout(400);
    await app.tab("home");
    t.has("and you are still as over as you were", await app.poolLine(), "MAD 200 past");
    await app.close();
  }

  {
    /* funding can never be larger than the expense it paid for */
    const app = await boot(browser, baseState({
      restAmount: 500, restFrom: "2026-08-01", restTs: ANCHOR,
      commitments: [{ id: "c1", name: "Dad", kind: "loan", amount: 1000, due: 5,
                      remaining: 2700, paid: {}, draws: [] }],
      expenses: [expense({ id: "x1", amount: 1200, date: "2026-08-10", note: "Tyres",
                           loanId: "c1", loanAdded: 700 })]
    }), { now: NOW });
    await app.page.click('[data-exp="x1"]');
    await app.page.waitForTimeout(300);
    await app.page.click("#d-edit");
    await app.page.waitForTimeout(350);
    await app.page.fill("#f-amount", "400");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(500);
    const s = await stored(app.page);
    t.near("shrinking the expense shrinks its funding to fit", s.expenses[0].loanAdded, 400, 0.01);
    t.near("and the loan gives back the difference", s.commitments[0].remaining, 2400, 0.01);
    await app.close();
  }

  {
    /* a note edit must not resurrect a draw the loan no longer owes */
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [{ id: "c1", name: "Dad", kind: "loan", amount: 1000, due: 5,
                      remaining: 100, paid: {}, draws: [] }],
      expenses: [expense({ id: "x1", amount: 300, date: "2026-08-18", note: "Fuel",
                           loanId: "c1", loanAdded: 300 })]
    }), { now: NOW });
    await app.page.click('[data-exp="x1"]');
    await app.page.waitForTimeout(300);
    await app.page.click("#d-edit");
    await app.page.waitForTimeout(350);
    await app.page.fill("#f-note", "Fuel and oil");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(450);
    const s = await stored(app.page);
    t.near("a loan paid down to 100 stays at 100", s.commitments[0].remaining, 100, 0.01);
    t.eq("and the note still changed", s.expenses[0].note, "Fuel and oil");
    await app.close();
  }
};
