/* The paths a person actually walks every day: log something, fix it, delete
   it, pay a bill, reconcile against real cash, look back through history. */
"use strict";
const { boot, baseState, expense } = require("../harness");

exports.name = "flows · everyday use";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();
  const NOW = "2026-08-18T09:00:00";

  /* ---------- add, edit, delete an expense ---------- */
  {
    const app = await boot(browser, baseState({ salary: 9000 }), { now: NOW });
    await app.page.click("#open-add"); await app.page.waitForTimeout(300);
    await app.page.click("#qa-expense"); await app.page.waitForTimeout(350);
    /* comma decimals: the way a French/Arabic keyboard actually types money */
    await app.page.fill("#f-amount", "7,5");
    await app.page.fill("#f-note", "Kahwa");
    await app.page.click("#f-save"); await app.page.waitForTimeout(400);

    let st = await app.stored();
    t.eq("one expense saved", st.expenses.length, 1);
    t.near("comma decimal parsed", st.expenses[0].amount, 7.5);
    t.eq("category guessed from the note", st.expenses[0].cat, "food");
    t.eq("dated today", st.expenses[0].date, "2026-08-18");

    /* edit it */
    const id = st.expenses[0].id;
    await app.page.click('[data-exp="' + id + '"]'); await app.page.waitForTimeout(400);
    await app.page.click("#d-edit"); await app.page.waitForTimeout(400);
    t.eq("edit form is prefilled", await app.page.inputValue("#f-note"), "Kahwa");
    await app.page.fill("#f-amount", "12");
    await app.page.click("#f-save"); await app.page.waitForTimeout(400);
    st = await app.stored();
    t.eq("still one expense after editing", st.expenses.length, 1);
    t.near("amount updated", st.expenses[0].amount, 12);

    /* delete it — one tap, recoverable from the toast rather than a confirm */
    await app.page.click('[data-exp="' + id + '"]'); await app.page.waitForTimeout(400);
    await app.page.click("#d-del"); await app.page.waitForTimeout(400);
    t.eq("deleted", (await app.stored()).expenses.length, 0);
    await app.page.click("#toast button"); await app.page.waitForTimeout(400);
    t.eq("and undo brings it back", (await app.stored()).expenses.length, 1);
    t.near("with the same amount", (await app.stored()).expenses[0].amount, 12);
    t.no("no page errors across the expense lifecycle", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---------- pay a bill for more than the plan ---------- */
  {
    const app = await boot(browser, baseState({
      salary: 9000,
      commitments: [{ id: "c1", name: "Dad loan", amount: 2500, kind: "loan", due: 3, remaining: 25000, paid: {} }]
    }), { now: NOW });
    await app.tab("plan");
    await app.page.click('[data-cm="c1"]'); await app.page.waitForTimeout(400);
    await app.page.fill("#c-paid", "2770");
    await app.page.click("#c-pay"); await app.page.waitForTimeout(400);
    const st = await app.stored();
    t.eq("the real amount is recorded", st.commitments[0].paid["2026-08"].amt, 2770);
    t.eq("the loan balance follows the real payment", st.commitments[0].remaining, 22230);
    await app.tab("home");
    t.eq("and the extra comes off spendable money", await app.hero(), "MAD 6,230");
    /* undo restores the balance exactly */
    await app.tab("plan");
    await app.page.click('[data-cm="c1"]'); await app.page.waitForTimeout(400);
    await app.page.click("#c-unpay"); await app.page.waitForTimeout(400);
    t.eq("undo puts the balance back", (await app.stored()).commitments[0].remaining, 25000);
    await app.close();
  }

  /* ---------- borrowing more against a loan you already have ---------- */
  {
    /* out of money, dad covers a 2,850 purchase, and "Dad" is a standing loan
       in Plan — not a friends-ledger person. It must land on that loan. */
    const app = await boot(browser, baseState({
      salary: 9000,
      commitments: [{ id: "dad", name: "Dad", amount: 1000, kind: "loan", due: 5,
                      remaining: 12000, paid: {}, borrowLog: [] }],
      expenses: [expense({ amount: 10850, date: "2026-08-10", cat: "out" })]
    }), { now: NOW });

    t.has("the offer names the loan, not a separate person", await app.page.evaluate(() => {
      const s = document.querySelector(".suggest"); return s ? s.textContent : "";
    }), "Add it to Dad?");
    await app.page.click("#h-borrow"); await app.page.waitForTimeout(400);

    let st = await app.stored();
    t.eq("it goes onto what you owe on that loan", st.commitments[0].remaining, 14850);
    t.eq("the monthly payment is untouched", st.commitments[0].amount, 1000);
    t.eq("no stray ledger person is created", st.debts.length, 0);
    t.has("and it says the new balance", await app.toast(), "you owe MAD 14,850");

    await app.page.click("#toast button"); await app.page.waitForTimeout(400);
    t.eq("undo takes it back off", (await app.stored()).commitments[0].remaining, 12000);

    /* the same thing from the loan's own sheet */
    await app.tab("plan");
    await app.page.click('[data-cm="dad"]'); await app.page.waitForTimeout(400);
    await app.page.fill("#c-borrow", "2850");
    await app.page.click("#c-borrow-go"); await app.page.waitForTimeout(400);
    st = await app.stored();
    t.eq("Plan offers the same action", st.commitments[0].remaining, 14850);
    t.eq("and records what was taken", st.commitments[0].borrowLog.map(l => l.amt).join(), "2850");
    await app.tab("plan");
    t.has("months-to-go follows the bigger balance", await app.page.evaluate(() => {
      const r = document.querySelector('[data-cm="dad"] .hl'); return r ? r.textContent : "";
    }), "MAD 14,850 left");
    await app.close();
  }
  {
    /* a subscription is not a loan — no borrowing against Netflix */
    const app = await boot(browser, baseState({
      salary: 9000,
      commitments: [{ id: "n", name: "Netflix", amount: 65, kind: "sub", due: 12, remaining: 0, paid: {} }]
    }), { now: NOW });
    await app.tab("plan");
    await app.page.click('[data-cm="n"]'); await app.page.waitForTimeout(400);
    t.no("subscriptions get no borrow field", await app.page.evaluate(() => !!document.querySelector("#c-borrow")));
    await app.close();
  }

  /* ---------- reconcile against real cash ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-08-18", restTs: 1,
      expenses: [expense({ amount: 190, date: "2026-08-18" })]
    }), { now: NOW });
    await app.page.click("#open-add"); await app.page.waitForTimeout(300);
    await app.page.click("#qa-cash"); await app.page.waitForTimeout(350);
    await app.page.fill("#cash-have", "640"); await app.page.waitForTimeout(180);
    t.has("it offers to log the gap", await app.page.evaluate(() => document.querySelector("#cash-go").textContent),
      "Log MAD 170");
    await app.confirmTap("#cash-go");
    const st = await app.stored();
    const missing = st.expenses.filter(e => e.cat === "missing");
    t.eq("the gap is logged once", missing.length, 1);
    t.near("for the right amount", missing[0].amount, 170);
    t.has("and the pool now matches the pocket", await app.poolLine(), "MAD 640 left of your MAD 1,000");
    await app.close();
  }

  /* a large difference must not commit on a single tap */
  {
    const app = await boot(browser, baseState({ restAmount: 3000, restFrom: "2026-08-18", restTs: 1 }), { now: NOW });
    await app.page.click("#open-add"); await app.page.waitForTimeout(300);
    await app.page.click("#qa-cash"); await app.page.waitForTimeout(350);
    await app.page.fill("#cash-have", "0"); await app.page.waitForTimeout(180);
    const before = await app.raw();
    await app.page.click("#cash-go"); await app.page.waitForTimeout(250);
    t.has("the first tap asks for confirmation", await app.page.evaluate(() => document.querySelector("#cash-go").textContent),
      "Tap again to log MAD 3,000");
    t.eq("and writes nothing", await app.raw(), before);
    /* changing the number must clear the armed confirmation */
    await app.page.fill("#cash-have", "2900"); await app.page.waitForTimeout(180);
    t.has("editing the amount disarms it", await app.page.evaluate(() => document.querySelector("#cash-go").textContent),
      "Log MAD 100");
    await app.close();
  }

  /* ---------- history ---------- */
  {
    const exps = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date("2026-08-18T12:00:00"); d.setDate(d.getDate() - i);
      exps.push(expense({ id: "e" + i, ts: 1000 + i, amount: 50, date: d.toISOString().slice(0, 10) }));
    }
    const app = await boot(browser, baseState({ salary: 9000, expenses: exps }), { now: NOW });
    t.eq("Home shows the most recent five days", (await app.dayGroups()).length, 5);
    t.has("with a way to see the rest", await app.page.evaluate(() => {
      const l = document.querySelector(".linkish"); return l ? l.textContent : "";
    }), "See all 8 days");
    await app.page.click(".linkish"); await app.page.waitForTimeout(350);
    t.eq("History opens on Days", await app.page.evaluate(() => {
      const c = document.querySelector("[data-hist].sel"); return c ? c.textContent : "";
    }), "Days");
    t.eq("every day is listed", await app.page.evaluate(() => document.querySelectorAll("[data-day]").length), 8);
    await app.page.click("[data-day]"); await app.page.waitForTimeout(300);
    t.ok("a day opens to show its entries", await app.page.evaluate(() => !!document.querySelector(".wk-detail .exp")));
    await app.close();
  }

  /* ---------- goals ---------- */
  {
    const app = await boot(browser, baseState({
      goals: [{ id: "g1", name: "Trip", target: 1000, saved: 900, monthly: 0 }]
    }), { now: NOW });
    await app.tab("plan");
    await app.page.click('[data-goal-add="g1"]'); await app.page.waitForTimeout(400);
    await app.page.fill("#gm-amount", "5000");
    await app.page.click("#gm-save"); await app.page.waitForTimeout(400);
    t.eq("a goal cannot bank past its target", (await app.stored()).goals[0].saved, 1000);
    await app.page.click('[data-goal-edit="g1"]'); await app.page.waitForTimeout(400);
    await app.page.click("#g-del"); await app.page.waitForTimeout(250);
    t.has("deleting says what it will throw away",
      await app.page.evaluate(() => document.querySelector("#g-del").textContent), "this drops MAD 1,000 saved");
    await app.close();
  }
};
