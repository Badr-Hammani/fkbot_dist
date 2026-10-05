/* Category budgets and custom categories.
   The checks that matter most are the data-safety ones: cleanExpenses rewrites
   any category it does not recognise to "Other", so a custom category that is
   not registered in time -- at load, on import, on restore -- silently loses
   every expense filed under it. That happened in development, at load(). */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem("weekend-wallet-v1")));
const COFFEE = { id: "ucoffee01", name: "Coffee", color: "#d6336c", emoji: "☕", hidden: 0 };
const september = () => baseState({
  salary: 9000, payday: 1, customCats: [Object.assign({}, COFFEE)],
  catBudgets: { "2026-09-01": { food: 1500, ucoffee01: 300, transport: 400 } },
  expenses: [
    expense({ id: "a", amount: 1450, date: "2026-09-05", cat: "food" }),
    expense({ id: "b", amount: 520, date: "2026-09-10", cat: "ucoffee01", note: "coffee" }),
    expense({ id: "c", amount: 120, date: "2026-09-12", cat: "transport" }),
    expense({ id: "d", amount: 200, date: "2026-09-14", cat: "gifts" }),
    { id: "m", ts: 9, amount: 999, cat: "missing", note: "Not logged", date: "2026-09-15", photo: null }
  ]
});

exports.name = "budgets · categories, budgets & the month-end review";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- a custom category survives every way state is rebuilt ---- */
  {
    const app = await boot(browser, september(), { now: "2026-09-20T09:00:00" });
    await app.page.reload();
    await app.page.waitForTimeout(400);
    let s = await stored(app.page);
    t.eq("a Coffee expense is still Coffee after a relaunch", s.expenses.find(e => e.id === "b").cat, "ucoffee01");

    await app.close();
  }

  /* ---- a backup carries categories and budgets, and its expenses keep them ---- */
  {
    const backup = JSON.stringify(september());
    /* start from a phone with no custom categories at all, so nothing but the
       file itself can supply "ucoffee01" */
    const app = await boot(browser, baseState({ salary: 1000 }), { now: "2026-09-20T09:00:00" });
    app.page.on("dialog", d => d.accept());
    await app.tab("settings");
    await app.page.setInputFiles("#s-import-file",
      { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(backup) });
    await app.page.waitForTimeout(700);
    const s = await stored(app.page);
    t.eq("importing a backup brings its custom category", (s.customCats || []).map(c => c.name).join(), "Coffee");
    t.eq("and its expenses stay in it", (s.expenses.find(e => e.id === "b") || {}).cat, "ucoffee01");
    t.ok("and the budgets come with it", !!(s.catBudgets && s.catBudgets["2026-09-01"]));
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- creating a category and budgeting it on the 1st ---- */
  {
    const app = await boot(browser, baseState({ salary: 9000, payday: 1 }), { now: "2026-09-01T09:00:00" });
    await app.tab("plan");
    await app.page.click("#p-cats");
    await app.page.waitForTimeout(300);
    await app.page.click("#cats-new");
    await app.page.waitForTimeout(300);
    await app.page.fill("#cat-name", "Gym");
    await app.page.click("#cat-save");
    await app.page.waitForTimeout(400);
    let s = await stored(app.page);
    t.eq("a new category is stored", (s.customCats || []).map(c => c.name).join(), "Gym");
    const gym = s.customCats[0].id;

    await app.page.evaluate(() => document.querySelector(".sheet-x").click());
    await app.page.waitForTimeout(300);
    await app.page.click("#p-bud-edit");
    await app.page.waitForTimeout(350);
    t.ok("it appears in the budget sheet", await app.page.evaluate(id => !!document.querySelector("#bud-" + id), gym));
    await app.page.fill("#bud-food", "1500");
    await app.page.fill("#bud-" + gym, "250");
    t.has("the running total compares with what the month leaves",
      await app.page.evaluate(() => document.querySelector("#bud-sum").innerText), "1,750");
    await app.page.click("#bud-save");
    await app.page.waitForTimeout(400);
    s = await stored(app.page);
    t.eq("budgets are stored against the period", JSON.stringify(s.catBudgets["2026-09-01"]),
      JSON.stringify({ food: 1500, [gym]: 250 }));
    t.has("Plan shows them", norm(await app.shellText()), "Gym");
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- live progress during the month ---- */
  {
    const app = await boot(browser, september(), { now: "2026-09-20T09:00:00" });
    await app.tab("plan");
    const card = norm(await app.page.evaluate(() => document.querySelector(".bud-card").innerText));
    t.has("an overspent budget says so", card, "MAD 220 over");
    t.has("a healthy one says what is left", card, "MAD 50 left");
    t.has("spending with no budget is counted separately", card, "Spent outside a budget MAD 200");
    t.no("the cash-check catch-all is not a category", /999/.test(card), card);

    /* the review is reachable mid-month, and judges a running month fairly */
    const link = app.page.locator('.bud-review-link[data-bud-review="2026-09"]');
    t.has("Plan offers this month's review", norm(await link.innerText()), "How is September going? On track for 2 of 3");
    t.ok("its arrow is arrow-sized", await link.evaluate(b => b.querySelector(":scope > svg").getBoundingClientRect().width <= 20));
    await link.click();
    await app.page.waitForTimeout(400);
    const live = norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText));
    t.has("it is labelled as still running", live, "September so far");
    t.has("scored on track, not right", live.toLowerCase(), "2/3 on track");
    t.has("money left is room, not a wrong guess", live, "room left");
    t.no("nothing is called over-budgeted before the month ends", /budgeted too much|about right/.test(live), live);
    t.has("an overspent budget is already over", live, "over already");
    t.ok("the score is drawn as a ring", await app.page.evaluate(() => !!document.querySelector("#sheet .rev-score .rs-fill")));
    t.no("and there is nothing to apply yet", await app.page.evaluate(() => !!document.querySelector("#rev-apply")));
    await app.close();
  }

  /* ---- the month-end review ---- */
  {
    const app = await boot(browser, september(), { now: "2026-10-02T09:00:00" });
    t.ok("Home offers last month's review", await app.page.evaluate(() => !!document.querySelector(".bud-nudge")));
    await app.page.click(".bud-nudge button");
    await app.page.waitForTimeout(350);
    const sheet = norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText));
    t.has("it scores the guesses", sheet, "1/3");
    t.has("food within 10% was right", sheet, "about right");
    t.has("coffee went over", sheet, "over by MAD 220");
    t.has("transport was over-budgeted", sheet, "MAD 280 left unspent");
    t.has("unbudgeted spending is listed", sheet, "Gifts");
    await app.page.click("#rev-apply");
    await app.page.waitForTimeout(400);
    const s = await stored(app.page);
    t.eq("next month keeps what worked and corrects the rest",
      JSON.stringify(s.catBudgets["2026-10-01"]),
      JSON.stringify({ ucoffee01: 520, transport: 120, food: 1500, gifts: 200 }));
    t.no("the nudge goes away once seen", await app.page.evaluate(() => !!document.querySelector(".bud-nudge")));
    await app.tab("history");
    await app.page.click('[data-hist="months"]');
    await app.page.waitForTimeout(300);
    t.has("History > Months carries the verdict", norm(await app.shellText()), "right for 1 of 3");
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- people who never budget are never nagged ---- */
  {
    const app = await boot(browser, baseState({ salary: 9000, payday: 1,
      expenses: [expense({ amount: 100, date: "2026-09-10" })] }), { now: "2026-10-02T09:00:00" });
    t.no("no review nudge without budgets", await app.page.evaluate(() => !!document.querySelector(".bud-nudge")));
    await app.close();
  }

  /* ---- a category in use can be hidden, never deleted ---- */
  {
    const app = await boot(browser, september(), { now: "2026-09-20T09:00:00" });
    await app.tab("plan");
    await app.page.click("#p-cats");
    await app.page.waitForTimeout(300);
    await app.page.click('[data-cat-edit="ucoffee01"]');
    await app.page.waitForTimeout(300);
    t.no("no delete for a category history points at", await app.page.evaluate(() => !!document.querySelector("#cat-del")));
    await app.page.click("#cat-hide");
    await app.page.waitForTimeout(400);
    const s = await stored(app.page);
    t.eq("hiding is stored", s.customCats[0].hidden, 1);
    t.eq("and the expenses keep their category", s.expenses.find(e => e.id === "b").cat, "ucoffee01");
    await app.page.evaluate(() => document.querySelector(".sheet-x").click());
    await app.page.waitForTimeout(300);
    await app.page.click("#open-add");
    await app.page.waitForTimeout(300);
    await app.page.click("#qa-expense");
    await app.page.waitForTimeout(350);
    t.no("a hidden category leaves the picker",
      await app.page.evaluate(() => !!document.querySelector('.chip[data-cat="ucoffee01"]')));
    await app.close();
  }

  /* ---- the note box learns your categories ---- */
  {
    const app = await boot(browser, september(), { now: "2026-09-20T09:00:00" });
    await app.page.click("#open-add");
    await app.page.waitForTimeout(300);
    await app.page.click("#qa-expense");
    await app.page.waitForTimeout(350);
    await app.page.type("#f-note", "coffee with Sara");
    t.ok("a note naming a custom category picks it", await app.page.evaluate(
      () => !!document.querySelector('.chip[data-cat="ucoffee01"].sel')));
    await app.close();
  }

  /* ---- budgets follow the period when the first salary receipt moves it ---- */
  {
    const st = september();
    st.catBudgets = { "2026-10-01": { food: 1200 } };
    st.salaryReceived = { "2026-09-28": { amount: 9000, date: "2026-09-28", ts: 1 } };
    st.payday = 28; st.paydayEnd = 30;
    const app = await boot(browser, st, { now: "2026-10-05T09:00:00" });
    await app.tab("plan");
    t.ok("budgets set on Oct 1 still show in the Sep 28 cycle",
      await app.page.evaluate(() => !!document.querySelector(".bud-card")));
    await app.close();
  }
};
