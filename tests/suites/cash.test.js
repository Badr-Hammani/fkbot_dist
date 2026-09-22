/* Round-10 regressions: every way cash leaves the pool, and every place the
   app used to announce money it had not written. */
"use strict";
const { boot, baseState, expense, norm, scanLib } = require("../harness");

const A = Date.parse("2026-09-08T09:00:00");
const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem("weekend-wallet-v1")));
const loan = over => Object.assign({ id: "c1", name: "Dad", kind: "loan", amount: 2000, due: 5,
                                     remaining: 20500, paid: {}, draws: [] }, over || {});

exports.name = "cash · everything that leaves the pool";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- paying a bill is cash leaving your pocket ---- */
  {
    const base = { restAmount: 1000, restFrom: "2026-09-08", restTs: A };
    const plain = await boot(browser, baseState(Object.assign({}, base, {
      commitments: [loan()]
    })), { now: "2026-09-10T09:00:00" });
    t.has("the pool starts at what was counted", await plain.poolLine(), "MAD 1,000 left of your MAD 1,000");
    await plain.close();

    /* borrow 500 against the loan, then repay 500: a wash, exactly as it is
       for a friend. Before, the borrow raised the pool and the repayment
       never lowered it. */
    const wash = await boot(browser, baseState(Object.assign({}, base, {
      commitments: [loan({ remaining: 20000,
        paid: { "2026-09": { amt: 500, ts: Date.parse("2026-09-09T10:00:00"), applied: 500 } },
        draws: [{ id: "d1", ts: Date.parse("2026-09-09T09:00:00"), date: "2026-09-09",
                  amount: 500, note: "x", balanceApplied: true }] })]
    })), { now: "2026-09-10T09:00:00" });
    t.has("borrowing from a loan and repaying it is a wash",
      await wash.poolLine(), "MAD 1,000 left of your MAD 1,000");
    await wash.close();

    /* a subscription payment is money gone, and did nothing at all before */
    const sub = await boot(browser, baseState(Object.assign({}, base, {
      commitments: [{ id: "c2", name: "Netflix", kind: "sub", amount: 100, due: 12, remaining: 0,
                      paid: { "2026-09": { amt: 100, ts: Date.parse("2026-09-09T10:00:00"), applied: 0 } } }]
    })), { now: "2026-09-10T09:00:00" });
    t.has("paying Netflix leaves the pool", await sub.poolLine(), "MAD 900 left of your MAD 900");
    await sub.close();
  }

  /* ---- "Not logged" must never become the default for new spending ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 2000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      expenses: [{ id: "m1", ts: Date.parse("2026-09-14T12:00:00"), amount: 3400, cat: "missing",
                   note: "Not logged", date: "2026-09-14", photo: null }]
    }), { now: "2026-09-16T09:00:00" });

    await app.page.click('[data-exp="m1"]');
    await app.page.waitForTimeout(300);
    await app.page.click("#d-edit");
    await app.page.waitForTimeout(350);
    t.ok("the row shows the category it has", await app.page.evaluate(
      () => !!document.querySelector('.chip[data-cat="missing"].sel')));
    t.ok("but it cannot be chosen", await app.page.evaluate(
      () => document.querySelector('.chip[data-cat="missing"]').disabled));
    await app.page.fill("#f-amount", "3300");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(450);

    const s = await stored(app.page);
    t.no("editing it does not make it the remembered default", s.lastCat === "missing", String(s.lastCat));
    await app.close();
  }

  /* ---- a write that did not happen is never announced ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [loan({ remaining: 20000 })]
    }), { now: "2026-09-16T09:00:00" });

    await app.page.evaluate(() => {
      /* a full phone */
      localStorage.setItem = function(){ throw new Error("QuotaExceededError"); };
    });
    await app.tab("plan");
    await app.page.click(".commitment-card");
    await app.page.waitForTimeout(300);
    const drawBtn = await app.page.evaluate(() => {
      const b = document.querySelector("#c-add-draw");
      if (b) { b.click(); return true; }
      return false;
    });
    if (drawBtn) {
      await app.page.waitForTimeout(350);
      await app.page.fill("#draw-amount", "500");
      await app.page.click("#draw-save");
      await app.page.waitForTimeout(400);
      t.no("a loan draw that failed to save is not announced as owed",
        /you now owe/i.test(norm(await app.toast())), norm(await app.toast()));
      const s = await stored(app.page);
      t.near("and the balance is untouched", s.commitments[0].remaining, 20000, 0.01);
    } else {
      t.ok("the borrowing sheet is reachable", false, "no control found");
    }
    await app.close();
  }

  /* ---- handwritten zeros ---- */
  {
    const lib = scanLib();
    const now = new Date("2026-09-16");
    t.near("1OO,OO reads as 100", lib.parseAmountToken("1OO,OO"), 100, 0.01);
    t.near("O,50 reads as 0.50", lib.parseAmountToken("O,50"), 0.5, 0.01);
    t.near("1OOO reads as 1000", lib.parseAmountToken("1OOO"), 1000, 0.01);
    const r = lib.parseReceiptText("SHOP\nTOTAL 1OO,OO", now);
    t.near("and a whole receipt reads it too", r.amount, 100, 0.01);
    t.near("normal receipts are unaffected",
      lib.parseReceiptText("MARJANE\nTOTAL TTC 1.234,56", now).amount, 1234.56, 0.01);
  }

  /* ---- payday is a day like any other in the statistics ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      salaryReceived: { "2026-09-01": { amount: 9000, date: "2026-09-01", ts: Date.parse("2026-09-01T09:00:00") } },
      expenses: [
        expense({ amount: 400, date: "2026-09-01" }),
        expense({ amount: 200, date: "2026-09-03" }),
        expense({ amount: 300, date: "2026-09-04" })
      ]
    }), { now: "2026-09-16T09:00:00" });
    await app.tab("history");
    const stats = norm(await app.page.evaluate(() =>
      [...document.querySelectorAll(".stat")].map(s => s.innerText.replace(/\n/g, " ")).join(" | ")));
    t.has("payday can be the biggest day", stats, "MAD 400");
    t.has("and the average counts all three days", stats, "MAD 300");
    await app.close();
  }

  /* ---- the checklist can be finished with ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      expenses: [expense({ amount: 50, date: "2026-09-10" })]
    }), { now: "2026-09-16T09:00:00" });
    t.ok("a user with no loans still sees the list", await app.page.evaluate(
      () => !!document.querySelector("#h-setup-hide")));
    await app.page.click("#h-setup-hide");
    await app.page.waitForTimeout(400);
    t.no("and can put it away", /getting started/i.test(norm(await app.shellText())));
    t.eq("which is remembered", (await stored(app.page)).setupHidden, 1);
    await app.close();
  }

  /* ---- a second tab cannot flatten the first ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      expenses: [expense({ id: "a", amount: 111, date: "2026-09-10" })]
    }), { now: "2026-09-16T09:00:00" });

    /* another copy of the app writes a newer state underneath us */
    await app.page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("weekend-wallet-v1"));
      raw.seq = (raw.seq || 0) + 50;
      raw.expenses.push({ id: "b", ts: 2, amount: 222, cat: "food", note: "other tab",
                          date: "2026-09-11", photo: null });
      localStorage.setItem("weekend-wallet-v1", JSON.stringify(raw));
    });

    await app.page.click("#open-add");
    await app.page.waitForTimeout(300);
    await app.page.click("#qa-expense");
    await app.page.waitForTimeout(350);
    await app.page.fill("#f-amount", "333");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(450);

    const ids = (await stored(app.page)).expenses.map(e => e.id);
    t.ok("the other tab's entry survives", ids.indexOf("b") > -1, JSON.stringify(ids));
    t.has("and the clash is explained", await app.toast(), "open in another tab");
    await app.close();
  }
};
