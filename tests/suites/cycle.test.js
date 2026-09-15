/* Round-8 regressions: the end of the cycle, the weekend, and reconciliation —
   the three moments the app was most likely to be wrong, and the ones that
   cost the most when it was. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem("weekend-wallet-v1")));
const secs = p => p.evaluate(() => [...document.querySelectorAll(".sec")].map(s => s.textContent).join(" | "));

exports.name = "cycle · payday, weekends & reconciliation";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- the cycle lasts until payday can no longer be late ---- */
  {
    const base = {
      salary: 9000, payday: 28, paydayEnd: 30,
      salaryReceived: { "2026-08-28": { amount: 9000, date: "2026-08-28", ts: 1 } },
      restAmount: 900, restFrom: "2026-09-24", restTs: Date.parse("2026-09-24T09:00:00")
    };
    /* a month after the receipt is the 28th, but the money may not land until
       the 30th — assuming one month handed over the whole pool as one day's
       spending for four days running */
    const cases = [
      { day: "2026-09-27", days: "4 days left", rate: "MAD 225" },
      { day: "2026-09-28", days: "3 days left", rate: "MAD 300" },
      { day: "2026-09-29", days: "2 days left", rate: "MAD 450" }
    ];
    for (const c of cases) {
      const app = await boot(browser, baseState(base), { now: c.day + "T09:00:00" });
      t.has(c.day + " has " + c.days, await secs(app.page), c.days);
      t.has("and a day's worth, not the whole pool", await app.todayLeft(), c.rate);
      await app.close();
    }
  }

  /* ---- correcting the salary date moves the receipt, never duplicates it ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      salaryReceived: { "2026-09-01": { amount: 9000, date: "2026-09-01", ts: 1 } }
    }), { now: "2026-09-10T09:00:00" });
    app.page.on("dialog", d => d.accept());
    await app.tab("plan");
    await app.page.fill("#p-salary-date", "2026-09-03");
    await app.page.click("#p-salary-received");
    await app.page.waitForTimeout(500);
    const keys = Object.keys((await stored(app.page)).salaryReceived);
    t.eq("one receipt, not two", keys.length, 1);
    t.eq("and it is the corrected date", keys[0], "2026-09-03");
    await app.close();
  }

  /* ---- borrowed cash is cash wherever it came from ---- */
  {
    const common = {
      restAmount: 1000, restFrom: "2026-09-14", restTs: Date.parse("2026-09-14T09:00:00"),
      commitments: [{ id: "c1", name: "Dad", kind: "loan", amount: 1000, due: 5,
                      remaining: 5000, paid: {}, draws: [] }]
    };
    const fromLoan = await boot(browser, baseState(Object.assign({}, common, {
      expenses: [expense({ id: "x", amount: 1500, date: "2026-09-20", loanId: "c1", loanAdded: 500 })]
    })), { now: "2026-09-21T09:00:00" });
    const loanLine = norm(await fromLoan.poolLine());
    await fromLoan.close();

    const fromPerson = await boot(browser, baseState(Object.assign({}, common, {
      expenses: [expense({ id: "x", amount: 1500, date: "2026-09-20", fundingType: "person",
                           fundingPersonId: "p1", fundingPersonName: "Ahmed",
                           fundingAmount: 500, fundingLogId: "l1" })],
      debts: [{ id: "p1", name: "Ahmed", balance: 500, log: [
        { id: "l1", ts: Date.parse("2026-09-20T12:00:00"), at: 1, amt: 500, dir: "b", note: "" }] }]
    })), { now: "2026-09-21T09:00:00" });
    const personLine = norm(await fromPerson.poolLine());
    await fromPerson.close();

    t.eq("500 from a loan reads the same as 500 from a friend", loanLine, personLine);
    t.has("and neither claims he is in the red when he is level", loanLine, "MAD 0 left");
  }

  /* ---- a cash check is a period's drift, not a day's spending ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      expenses: [
        expense({ amount: 300, date: "2026-09-05" }),
        expense({ amount: 300, date: "2026-09-10" }),
        expense({ amount: 200, date: "2026-09-14" }),
        { id: "m1", ts: Date.parse("2026-09-19T12:00:00"), amount: 1300, cat: "missing",
          note: "Not logged", date: "2026-09-19", photo: null }
      ]
    }), { now: "2026-09-19T13:00:00" });

    t.has("it still comes off the pool", await app.poolLine(), "MAD 900 left of your MAD 3,000");
    t.no("but the day he found it does not read as overspent",
      /over/.test(norm(await app.todayLeft())), norm(await app.todayLeft()));

    await app.tab("history");
    const stats = norm(await app.page.evaluate(() =>
      [...document.querySelectorAll(".stat")].map(s => s.innerText.replace(/\n/g, " ")).join(" | ")));
    t.no("and it never becomes the biggest day", /1,300/.test(stats), stats);
    t.has("the real biggest day stands", stats, "MAD 300");
    await app.close();
  }

  /* ---- a frozen weekend figure cannot outlive the money ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-09-14", restTs: Date.parse("2026-09-14T09:00:00"),
      wkPlan: { "2026-09-18": 900 },
      debts: [{ id: "p1", name: "Ahmed", balance: -2200, log: [
        { id: "l1", ts: Date.parse("2026-09-19T12:00:00"), at: 1, amt: 2200, dir: "r", note: "" }] }]
    }), { now: "2026-09-20T09:00:00" });
    const shell = norm(await app.shellText());
    t.no("the weekend card cannot promise 900 when 800 is left",
      /MAD 900 left/.test(shell), shell.slice(0, 400));
    await app.close();
  }

  /* ---- the debt estimate uses what he actually pays ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1,
      commitments: [{ id: "c1", name: "Dad", kind: "loan", amount: 2000, due: 5, remaining: 12000,
                      coverShortfall: true, draws: [],
                      paid: { "2026-09": { amt: 500, ts: 1, applied: 500 },
                              "2026-08": { amt: 500, ts: 1, applied: 500 },
                              "2026-07": { amt: 500, ts: 1, applied: 500 } } }]
    }), { now: "2026-09-20T09:00:00" });
    const shell = norm(await app.shellText());
    t.has("paying 500 against a 2,000 plan is 24 months, not 6", shell, "24 months");
    await app.close();
  }

  /* ---- a faded toast is not a live button ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 2000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      goals: [{ id: "g1", name: "Trip", target: 5000, saved: 0, monthly: 0, contributions: [] }]
    }), { now: "2026-09-10T09:00:00" });
    await app.tab("plan");
    await app.page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(x => /add money/i.test(x.textContent));
      if (b) b.click();
    });
    await app.page.waitForTimeout(350);
    await app.page.fill("#gm-amount", "800");
    await app.page.click("#gm-save");
    await app.page.waitForTimeout(300);
    t.ok("the undo is there while the toast is up",
      await app.page.evaluate(() => !!document.querySelector("#toast button")));
    await app.page.waitForTimeout(7000);          /* let it fade out */
    t.no("and is gone once it fades, not merely invisible",
      await app.page.evaluate(() => !!document.querySelector("#toast button")));
    t.near("so the contribution stands", (await stored(app.page)).goals[0].saved, 800, 0.01);
    await app.close();
  }

  /* ---- money buttons cannot fire twice ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      goals: [{ id: "g1", name: "Trip", target: 9000, saved: 0, monthly: 0, contributions: [] }]
    }), { now: "2026-09-10T09:00:00" });
    await app.tab("plan");
    await app.page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find(x => /add money/i.test(x.textContent));
      if (b) b.click();
    });
    await app.page.waitForTimeout(350);
    await app.page.fill("#gm-amount", "800");
    await app.page.evaluate(() => {
      const b = document.querySelector("#gm-save");
      b.click(); b.click(); b.click();           /* a laggy phone, one impatient thumb */
    });
    await app.page.waitForTimeout(450);
    const g = (await stored(app.page)).goals[0];
    t.near("three taps put 800 away, not 2,400", g.saved, 800, 0.01);
    t.eq("and wrote one record", (g.contributions || []).length, 1);
    await app.close();
  }
};
