/* Round-9 regressions: getting your data back, and not being told things
   that are not true. */
"use strict";
const { boot, baseState, expense, norm, scanLib } = require("../harness");

const stored = p => p.evaluate(() => JSON.parse(localStorage.getItem("weekend-wallet-v1")));

exports.name = "recovery · erase, scan honesty & structure";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- erasing must not strand you ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 2000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      expenses: [expense({ amount: 120, date: "2026-09-10" }), expense({ amount: 80, date: "2026-09-11" })]
    }), { now: "2026-09-16T09:00:00" });

    app.page.on("dialog", d => d.accept());
    await app.tab("settings");
    await app.page.click("#s-wipe");                 /* arms */
    await app.page.waitForTimeout(150);
    await app.page.click("#s-wipe");                 /* confirms */
    await app.page.waitForTimeout(500);

    const screen = await app.page.evaluate(() => ({
      restore: !!document.querySelector("#o-restore"),
      importer: !!document.querySelector("#o-import"),
      text: document.querySelector("#shell").innerText
    }));
    t.ok("the erase screen offers the copy back", screen.restore, screen.text.slice(0, 200));
    t.ok("and a backup file as well", screen.importer);
    t.has("it says what is in the copy", norm(screen.text), "2 expenses");

    /* don't let a missing control abort the rest of the suite */
    if (screen.restore) {
      await app.page.click("#o-restore");
      await app.page.waitForTimeout(500);
      const s = await stored(app.page);
      t.eq("and putting it back really restores it", s.expenses.length, 2);
      t.near("with the money intact", s.restAmount, 2000, 0.01);
    } else {
      t.ok("and putting it back really restores it", false, "no restore control to click");
    }
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- the scanner must not read reference numbers as money ---- */
  {
    const lib = scanLib();
    const now = new Date("2026-09-16");
    const cases = [
      { name: "a phone number is not a price",
        text: "SNACK AMINE\nTEL 0661 23 45 67\nTACOS 35,00\nJUS 12,00", not: 661 },
      { name: "a card number is not a price",
        text: "BOUTIQUE X\nCARTE 4532 1234 5678 9012\nARTICLE 250,00", is: 250, not: 9012 }
    ];
    for (const c of cases) {
      const r = lib.parseReceiptText(c.text, now);
      if (c.is != null) t.near(c.name, r.amount, c.is, 0.01);
      else t.no(c.name, Math.abs((r.amount || 0) - c.not) < 0.01, String(r.amount));
    }
    /* a reading is not a guess, and the difference has to reach the user */
    const read = lib.parseReceiptText("CAFE ATLAS\nCAPPUCCINO 22,00\nTOTAL TTC 22,00", now);
    t.no("an amount off a TOTAL line is not flagged as a guess", read.amountGuessed);
    const guess = lib.parseReceiptText("HANOUT\nPAIN 3,00\nLAIT 7,50\n300,00", now);
    t.ok("with no total line, the amount is flagged as a guess", guess.amountGuessed);
    /* OCR reads handwritten zeros as the letter O */
    t.near("1O0,OO reads as 100", lib.parseAmountToken("1O0,OO"), 100, 0.01);
  }

  /* ---- the app must not claim a scanner it cannot use ---- */
  {
    const app = await boot(browser, baseState({ salary: 9000, payday: 1 }), { now: "2026-09-16T09:00:00" });
    await app.tab("settings");
    await app.page.selectOption("#s-provider", "claude");
    await app.page.waitForTimeout(200);
    await app.page.fill("#s-claude-key", "");
    await app.page.click("#s-scan-save");
    await app.page.waitForTimeout(300);
    const msg = norm(await app.toast());
    t.no("it does not say Claude scanning is on with no key", /Claude scanning is on/.test(msg), msg);
    t.has("it says the key is missing", msg, "needs its key");
    await app.close();
  }

  /* ---- a cash-check reconciliation cannot be manufactured by hand ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 2000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      expenses: [{ id: "m1", ts: Date.parse("2026-09-14T12:00:00"), amount: 340, cat: "missing",
                   note: "Not logged", date: "2026-09-14", photo: null }]
    }), { now: "2026-09-16T09:00:00" });
    await app.page.click('[data-exp="m1"]');
    await app.page.waitForTimeout(350);
    t.no("no 'log this again' on a cash-check row",
      await app.page.evaluate(() => !!document.querySelector("#d-again")));
    /* but editing it must still work, and show which category it is */
    await app.page.click("#d-edit");
    await app.page.waitForTimeout(350);
    t.ok("the edit sheet shows the category it actually has",
      await app.page.evaluate(() => !!document.querySelector('.chip[data-cat="missing"].sel')));
    await app.close();
  }

  /* ---- structure a screen reader can navigate ---- */
  {
    const app = await boot(browser, baseState({
      salary: 9000, payday: 1, restAmount: 2000, restFrom: "2026-09-01",
      restTs: Date.parse("2026-09-01T09:00:00"),
      expenses: [expense({ amount: 120, date: "2026-09-10" })]
    }), { now: "2026-09-16T09:00:00" });

    t.eq("there is exactly one h1", await app.page.evaluate(() => document.querySelectorAll("h1").length), 1);
    const bare = await app.page.evaluate(() =>
      [...document.querySelectorAll("h1,h2,h3")]
        .map(h => (h.getAttribute("aria-label") || h.textContent).trim())
        .filter(x => /^[A-Z]{0,3}\s?[\d.,  ]+$/.test(x)));
    t.eq("no heading is a bare number", bare.length, 0, JSON.stringify(bare));

    await app.tab("history");
    t.ok("History has headings to navigate by",
      await app.page.evaluate(() => document.querySelectorAll("#shell h1,#shell h2,#shell h3").length > 0));
    await app.close();
  }

  /* ---- focus has somewhere to land after a delete ---- */
  {
    const app = await boot(browser, baseState({
      restAmount: 2000, restFrom: "2026-09-01", restTs: Date.parse("2026-09-01T09:00:00"),
      expenses: [expense({ id: "x1", amount: 120, date: "2026-09-10" })]
    }), { now: "2026-09-16T09:00:00" });
    await app.page.click('[data-exp="x1"]');
    await app.page.waitForTimeout(300);
    await app.page.click("#d-del");
    await app.page.waitForTimeout(450);
    t.no("focus does not fall to the body after a delete",
      await app.page.evaluate(() => document.activeElement === document.body));
    await app.close();
  }
};
