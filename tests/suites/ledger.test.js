/* Money moved with people: lending, borrowing, being repaid, and splitting.
   The subtle rule this protects: being repaid is cash coming back and raises
   what you can spend; borrowing is not, because it funds money you already
   counted. Getting that backwards double-counts every loan from your dad. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

exports.name = "ledger · people, debts & splits";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();
  const NOW = "2026-08-18T09:00:00";
  const person = (over) => Object.assign({ id: "d1", name: "Hamza", balance: 0, log: [] }, over || {});
  const openPerson = async (app, id) => {
    await app.tab("plan");
    await app.page.click('[data-debt="' + id + '"]').catch(() => app.page.click('[data-ledger="' + id + '"]'));
    await app.page.waitForTimeout(400);
  };

  /* ---------- lending reduces what you can spend ---------- */
  {
    const app = await boot(browser, baseState({
      salary: 9000,
      debts: [person({ balance: -400, log: [{ ts: Date.parse("2026-08-18T08:00:00"), amt: 400, dir: "r", note: "" }] })],
      expenses: [expense({ amount: 38, date: "2026-08-18" })]
    }), { now: NOW });
    t.eq("money lent leaves your pocket", await app.hero(), "MAD 8,562");
    const days = await app.dayGroups();
    t.eq("the day total includes it", days[0].total, "MAD 438");
    t.has("and it appears as a row", days[0].rows.join(" "), "you gave");
    await app.close();
  }

  /* ---------- being repaid brings cash back ---------- */
  {
    const app = await boot(browser, baseState({
      debts: [person({ balance: 0, log: [
        { ts: Date.parse("2026-08-10T10:00:00"), amt: 400, dir: "r", note: "" },
        { ts: Date.parse("2026-08-18T10:00:00"), amt: 400, dir: "b", note: "" }] })],
      expenses: [expense({ amount: 38, date: "2026-08-18" })]
    }), { now: NOW });
    const days = await app.dayGroups();
    t.eq("a repayment day reads as money in", days[0].total, "+MAD 362");
    await app.close();
  }

  /* ---------- borrowing is not spendable twice ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-08-01", restTs: 1,
      debts: [person({ name: "Dad", balance: 500,
                       log: [{ ts: Date.parse("2026-08-10T10:00:00"), amt: 500, dir: "b", note: "" }] })]
    }), { now: NOW });
    t.has("borrowed money does not inflate the pool", await app.poolLine(), "MAD 1,000 left of your MAD 1,000");
    await app.close();
  }

  /* ---------- undo reverses balance AND any budget bump ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-01", restTs: 1, debts: [person({ name: "Dad" })]
    }), { now: NOW });
    await openPerson(app, "d1");
    await app.page.fill("#d2-amt", "500");
    await app.page.click("#d2-theygave");
    await app.page.waitForTimeout(400);
    await app.page.click("#toast button");            /* accept the budget bump */
    await app.page.waitForTimeout(400);
    t.eq("bump applied", (await app.stored()).restAmount, 3500);
    await openPerson(app, "d1");
    await app.page.click("#d2-undo");
    await app.page.waitForTimeout(400);
    const st = await app.stored();
    t.eq("undo reverses the bump too", st.restAmount, 3000);
    t.eq("undo reverses the balance", st.debts[0].balance, 0);
    t.eq("undo removes the log entry", st.debts[0].log.length, 0);
    await app.close();
  }

  /* ---------- you cannot delete away a live balance ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-01", restTs: 1,
      debts: [person({ name: "Sara", balance: -500,
                       log: [{ ts: Date.parse("2026-08-10T10:00:00"), amt: 500, dir: "r", note: "" }] })]
    }), { now: NOW });
    const before = norm(await app.poolLine());
    await openPerson(app, "d1");
    await app.page.click("#d2-del"); await app.page.waitForTimeout(200);
    await app.page.click("#d2-del"); await app.page.waitForTimeout(300);
    t.eq("person is kept", (await app.stored()).debts.length, 1);
    t.has("and the refusal is explained", await app.toast(), "still owes you");
    await app.page.click(".sheet-x"); await app.page.waitForTimeout(400);
    await app.tab("home");
    t.eq("the money does not come back", norm(await app.poolLine()), before);
    await app.close();
  }

  /* ---------- splitting a bill ---------- */
  {
    const app = await boot(browser, baseState({ debts: [person({ name: "Sara" })] }), { now: NOW });
    await app.page.click("#open-add"); await app.page.waitForTimeout(300);
    await app.page.click("#qa-split"); await app.page.waitForTimeout(400);
    await app.page.fill("#sp-total", "100");
    /* typing an existing name in a different case must select the same person */
    await app.page.fill("#sp-newname", "sara");
    await app.page.click("#sp-addperson"); await app.page.waitForTimeout(300);
    const chips = await app.page.evaluate(() =>
      [...document.querySelectorAll("#sp-people [data-who]")].map(c => c.textContent.trim() + (c.className.includes("sel") ? "*" : "")));
    t.eq("lowercase name selects the existing chip", chips.join(","), "Me*,Sara*");
    await app.page.click("#sp-save"); await app.page.waitForTimeout(400);
    const st = await app.stored();
    t.eq("one ledger entry, not two", st.debts[0].log.length, 1);
    t.eq("they owe exactly half", st.debts[0].balance, -50);
    t.eq("your share is half", st.expenses[0].amount, 50);
    await app.close();
  }

  /* an uneven split must still add up to the bill */
  {
    const app = await boot(browser, baseState({
      debts: [person({ name: "Sara" }), person({ id: "d2", name: "Ali" })]
    }), { now: NOW });
    await app.page.click("#open-add"); await app.page.waitForTimeout(300);
    await app.page.click("#qa-split"); await app.page.waitForTimeout(400);
    await app.page.fill("#sp-total", "100");
    await app.page.click('[data-who="Sara"]');
    await app.page.click('[data-who="Ali"]');
    await app.page.waitForTimeout(200);
    await app.page.click("#sp-save"); await app.page.waitForTimeout(400);
    const st = await app.stored();
    const mine = st.expenses[0].amount;
    const owed = -st.debts.reduce((s, d) => s + d.balance, 0);
    t.near("100 split three ways adds up to 100", Math.round((mine + owed) * 100) / 100, 100);
    await app.close();
  }

  /* ---------- going past your money is a loan from someone ---------- */
  {
    /* the pool path: this used to offer nothing at all when you went over */
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-01", restTs: 1,
      debts: [person({ id: "dad", name: "Dad", balance: 1500,
                       log: [{ ts: Date.parse("2026-07-05"), amt: 1500, dir: "b", note: "" }] })],
      expenses: [expense({ amount: 5850, date: "2026-08-10", cat: "out" })]
    }), { now: NOW });
    t.has("it names the person you actually borrow from", await app.page.evaluate(() => {
      const s = document.querySelector(".suggest"); return s ? s.textContent : "";
    }), "Add it to Dad's loan?");
    const poolBefore = norm(await app.poolLine());

    await app.page.click("#h-borrow"); await app.page.waitForTimeout(400);
    const st = await app.stored();
    t.eq("one tap adds it to what you owe them", st.debts[0].balance, 4350);
    t.eq("recorded as a real ledger entry", st.debts[0].log.length, 2);
    t.eq("labelled so you know why", st.debts[0].log[1].note, "covered my overspend");
    t.eq("and borrowing does not hand the money back to the budget",
      norm(await app.poolLine()), poolBefore);
    t.no("the offer is gone once logged", await app.page.evaluate(() => !!document.querySelector("#h-borrow")));

    /* and it is undoable straight from the toast */
    await app.page.click("#toast button"); await app.page.waitForTimeout(400);
    t.eq("undo removes it again", (await app.stored()).debts[0].balance, 1500);
    await app.close();
  }
  {
    /* the offer must never state a different "over" figure than the one shown
       in red — 2,850 on screen and "you're 1,050 past your money" underneath
       reads as the app contradicting itself */
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-01", restTs: 1,
      debts: [person({ id: "dad", name: "Dad", balance: 1800,
                       log: [{ ts: Date.parse("2026-08-06"), amt: 1800, dir: "b", note: "" }] })],
      expenses: [expense({ amount: 5850, date: "2026-08-10", cat: "out" })]
    }), { now: NOW });
    const red = norm(await app.poolLine());
    const txt = norm(await app.page.evaluate(() => {
      const s = document.querySelector(".suggest"); return s ? s.textContent : "";
    }));
    t.has("the red line shows the full overspend", red, "MAD 2,850 past your MAD 3,000");
    t.has("and the offer leads with the same figure", txt, "You're MAD 2,850 past your money");
    t.has("it says what is already borrowed", txt, "MAD 1,800 is already borrowed");
    t.has("and asks only for the rest, naming where it goes", txt, "add the other MAD 1,050 to Dad?");
    t.has("the button names the amount it will add", await app.page.evaluate(() => {
      const b = document.querySelector("#h-borrow"); return b ? b.textContent : "";
    }), "Add MAD 1,050");
    await app.page.click("#h-borrow"); await app.page.waitForTimeout(400);
    t.eq("and adds exactly that", (await app.stored()).debts[0].balance, 2850);
    await app.close();
  }
  {
    /* the salary path keeps working */
    const app = await boot(browser, baseState({
      salary: 9000,
      debts: [person({ id: "dad", name: "Dad", balance: 0,
                       log: [{ ts: Date.parse("2026-07-05"), amt: 900, dir: "b", note: "" }] })],
      expenses: [expense({ amount: 11000, date: "2026-08-10", cat: "out" })]
    }), { now: NOW });
    t.has("salary overspend offers the same thing", await app.page.evaluate(() => {
      const s = document.querySelector(".suggest"); return s ? s.textContent : "";
    }), "Add it to Dad's loan?");
    await app.close();
  }
  {
    /* nobody to name yet */
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-08-01", restTs: 1,
      expenses: [expense({ amount: 2000, date: "2026-08-10" })]
    }), { now: NOW });
    t.has("with no lender known it stays generic", await app.page.evaluate(() => {
      const b = document.querySelector("#h-borrow"); return b ? b.textContent : "";
    }), "Log it");
    await app.close();
  }
  {
    /* and it never nags when you are inside your money */
    const app = await boot(browser, baseState({ restAmount: 1000, restFrom: "2026-08-01", restTs: 1 }), { now: NOW });
    t.no("no offer when you are not over", await app.page.evaluate(() => !!document.querySelector("#h-borrow")));
    await app.close();
  }

  /* ---------- classification of incoming money ---------- */
  {
    /* they owed you 300; they hand you 500 → 300 is repayment, 200 is a loan */
    const app = await boot(browser, baseState({
      restAmount: 1000, restFrom: "2026-08-01", restTs: 1,
      debts: [person({ name: "Ali", balance: 200, log: [
        { ts: Date.parse("2026-08-05T10:00:00"), amt: 300, dir: "r", note: "" },
        { ts: Date.parse("2026-08-10T10:00:00"), amt: 500, dir: "b", note: "" }] })]
    }), { now: NOW });
    const foot = (await app.footLines()).join(" ");
    t.has("the repaid part is counted as cash in", foot, "+MAD 300 paid back to you");
    t.has("the borrowed part is flagged, not counted twice", foot, "MAD 200 borrowed");
    await app.close();
  }
};
