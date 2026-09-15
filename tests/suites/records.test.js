/* Round-6 regressions: keeping records the owner cannot reconstruct.
   The worst defect this round was reachable from the Edit button on every
   expense in the app and destroyed a friend's debt with no warning and no
   undo. These checks all guard records, not presentation. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem("weekend-wallet-v1")));

/* an expense already funded by a friend, exactly as the app writes it */
function fundedByPerson(over) {
  return expense(Object.assign({
    id: "x1", amount: 1200, date: "2026-08-18", note: "Party", cat: "out",
    fundingType: "person", fundingPersonId: "d1", fundingPersonName: "Ahmed",
    fundingAmount: 200, fundingLogId: "l1",
    loanId: "", loanAdded: 0
  }, over || {}));
}
const ahmed = () => ({ id: "d1", name: "Ahmed", balance: 200, log: [
  { id: "l1", ts: new Date("2026-08-18T10:00:00").getTime(), amt: 200, dir: "b", note: "Funding: Party" }
] });

async function editNoteAndSave(app, newNote) {
  await app.page.click('[data-exp="x1"]');
  await app.page.waitForTimeout(300);
  await app.page.click("#d-edit");
  await app.page.waitForTimeout(350);
  await app.page.fill("#f-note", newNote);
  await app.page.click("#f-save");
  await app.page.waitForTimeout(450);
}

exports.name = "records · edits must not destroy what paid for things";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- editing a note keeps the friend's debt ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1, expenses: [fundedByPerson()], debts: [ahmed()]
    }), { now: "2026-08-18T12:00:00" });

    await editNoteAndSave(app, "Party at Karim's");
    const s = await stored(app.page);
    const d = s.debts.find(x => x.name === "Ahmed");
    t.near("Ahmed is still owed his 200 after an edit", d ? d.balance : -1, 200, 0.01);
    t.ok("and the ledger entry still exists", !!(d && d.log.length === 1), d && d.log.length);
    t.eq("the note really did change", s.expenses[0].note, "Party at Karim's");
    t.near("the funding is still attached to the expense",
      s.expenses[0].fundingAmount, 200, 0.01);
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- editing the date keeps it too, and moves the ledger entry with it ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1, expenses: [fundedByPerson()], debts: [ahmed()]
    }), { now: "2026-08-18T12:00:00" });

    await app.page.click('[data-exp="x1"]');
    await app.page.waitForTimeout(300);
    await app.page.click("#d-edit");
    await app.page.waitForTimeout(350);
    await app.page.fill("#f-date", "2026-08-17");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(450);

    const s = await stored(app.page);
    const d = s.debts.find(x => x.name === "Ahmed");
    t.near("changing the date does not clear the debt", d ? d.balance : -1, 200, 0.01);
    t.eq("and the expense moved", s.expenses[0].date, "2026-08-17");
    await app.close();
  }

  /* ---- the same for a loan-funded expense ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [{ id: "c1", name: "Dad", kind: "loan", amount: 1000, due: 5,
                      remaining: 1200, paid: {}, draws: [] }],
      expenses: [expense({ id: "x1", amount: 900, date: "2026-08-18", note: "Tyres",
                           loanId: "c1", loanAdded: 300 })]
    }), { now: "2026-08-18T12:00:00" });

    await editNoteAndSave(app, "New tyres");
    const s = await stored(app.page);
    t.near("the loan balance survives an edit", s.commitments[0].remaining, 1200, 0.01);
    t.near("and the draw is still recorded on the expense", s.expenses[0].loanAdded, 300, 0.01);
    await app.close();
  }

  /* ---- delete then undo on a paid-off loan invents nothing ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [{ id: "c1", name: "Dad", kind: "loan", amount: 1000, due: 5,
                      remaining: 0, paid: {}, draws: [] }],
      expenses: [expense({ id: "x1", amount: 300, date: "2026-08-18", note: "Fuel",
                           loanId: "c1", loanAdded: 300 })]
    }), { now: "2026-08-18T12:00:00" });

    await app.page.click('[data-exp="x1"]');
    await app.page.waitForTimeout(300);
    await app.page.click("#d-del");
    await app.page.waitForTimeout(400);
    t.near("deleting takes nothing off an already-cleared loan",
      (await stored(app.page)).commitments[0].remaining, 0, 0.01);

    await app.page.click("#toast button");
    await app.page.waitForTimeout(450);
    t.near("and undoing it does not create debt that was already paid",
      (await stored(app.page)).commitments[0].remaining, 0, 0.01);
    await app.close();
  }

  /* ---- logging salary retires the cash count from the cycle that ended ---- */
  {
    const app = await boot(browser, baseState({
      salary: 10000, payday: 20,
      restAmount: 2000, restFrom: "2026-08-10",
      restTs: new Date("2026-08-10T09:00:00").getTime()
    }), { now: "2026-08-20T09:00:00" });

    await app.tab("plan");
    await app.page.fill("#p-salary-date", "2026-08-20");
    await app.page.click("#p-salary-received");
    await app.page.waitForTimeout(500);
    await app.tab("home");

    const s = await stored(app.page);
    t.near("last cycle's pool is retired the moment salary is logged", s.restAmount, 0, 0.01);
    const shell = norm(await app.shellText());
    t.no("and Home stops quoting it without a reload",
      /2,000 left of your/.test(shell), shell.slice(0, 260));
    await app.close();
  }

  /* ---- a calendar month and a salary cycle cannot both claim one expense ---- */
  {
    const app = await boot(browser, baseState({
      salary: 10000, payday: 20,
      salaryReceived: { "2026-08-20": { amount: 10000, date: "2026-08-20", ts: 1 } },
      expenses: [
        expense({ id: "a", amount: 100, date: "2026-08-10", ts: 1 }),
        expense({ id: "b", amount: 200, date: "2026-08-25", ts: 2 })
      ]
    }), { now: "2026-08-28T09:00:00" });

    await app.tab("history");
    await app.page.click('[data-hist="months"]');
    await app.page.waitForTimeout(300);

    const rows = await app.page.evaluate(() => [...document.querySelectorAll(".wk")].map(w => ({
      label: w.querySelector(".wk-label").innerText,
      total: w.querySelector(".wk-amt").innerText,
      sub: w.querySelector(".wk-sub").innerText
    })));
    const legacy = rows.find(r => /August/i.test(r.label));
    t.ok("the calendar-month row exists", !!legacy, JSON.stringify(rows));
    if (legacy) {
      t.has("it counts only what happened before the cycle began", legacy.total, "100");
      t.no("it does not also swallow the cycle's spending",
        /300/.test(norm(legacy.total)), legacy.total);
      t.has("and its count matches its total", legacy.sub, "1 expense");
    }
    await app.close();
  }

  /* ---- the hero cannot contradict its own caption ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1, restAmount: 3000, restFrom: "2026-08-16",
      restTs: new Date("2026-08-16T09:00:00").getTime(),
      debts: [{ id: "d1", name: "Ahmed", balance: -500, log: [
        { id: "l1", ts: new Date("2026-08-17T09:00:00").getTime(), amt: 500, dir: "r", note: "" }
      ] }]
    }), { now: "2026-08-18T09:00:00" });

    const r = await app.page.evaluate(() => {
      const bar = document.querySelector(".hero .meter-fill");
      return {
        hero: document.querySelector(".hero-amount").innerText,
        caption: document.querySelector(".hero-caption").innerText,
        pct: bar ? parseFloat(bar.style.width) : null
      };
    });
    const m = norm(r.caption).match(/spent\s+(?:[A-Z]{3}\s*)?([\d.,]+)\s+of\s+(?:[A-Z]{3}\s*)?([\d.,]+)/i);
    t.ok("the caption states a spend", !!m, r.caption);
    if (m) {
      const n = x => parseFloat(x.replace(/[^\d.]/g, ""));
      const spent = n(m[1]), of = n(m[2]);
      /* Under the cash-is-cash rule the owner chose (v8.4), money handed to a
         friend lowers what you HAVE rather than counting as something you
         spent -- so the budget base drops to 2,500 and the foot line names
         the 500 that went out. What must never differ is base - spent and
         the headline, which the next two checks pin down. */
      t.near("lending 500 lowers the money you have", of, 2500, 0.01);
      t.near("and is not double-counted as spending", spent, 0, 0.01);
      t.has("the line says where it went",
        (await app.footLines()).join(" | "), "MAD 500 given out");
      t.near("headline equals budget minus what the caption says went",
        n(norm(r.hero)), of - spent, 0.01);
      t.near("and the bar agrees", r.pct, spent / of * 100, 0.2);
    }
    await app.close();
  }
};
