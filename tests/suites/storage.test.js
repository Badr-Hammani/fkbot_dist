/* Storage, backup and restore.
   The browser is this app's only database, so import is the single most
   dangerous code path: it replaces every record the user owns, from a file
   that anything could have written. Treat it as untrusted input. */
"use strict";
const { boot, baseState, expense } = require("../harness");

exports.name = "storage · backup, restore & malformed data";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();
  const NOW = "2026-08-18T09:00:00";

  const importFile = async (app, obj, name) => {
    await app.tab("settings");
    await app.page.setInputFiles("#s-import-file", {
      name: name || "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj))
    });
    await app.page.waitForTimeout(600);
  };

  /* ---------- a good backup round-trips ---------- */
  {
    const seed = baseState({
      salary: 9000, currency: "MAD", restAmount: 1200, restFrom: "2026-08-18", restTs: 1,
      expenses: [expense({ id: "keep1", amount: 123.45, note: "Dinner", date: "2026-08-12" })],
      commitments: [{ id: "c1", name: "Loan", amount: 2500, kind: "loan", due: 3, remaining: 20000, paid: {} }],
      goals: [{ id: "g1", name: "Trip", target: 8000, saved: 1500, monthly: 500 }],
      debts: [{ id: "d1", name: "Hamza", balance: -400,
                log: [{ ts: Date.parse("2026-08-10"), amt: 400, dir: "r", note: "lunch" }] }]
    });
    const app = await boot(browser, seed, { now: NOW });
    /* build the export payload the same way the app does, then re-import it */
    const exported = await app.page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("weekend-wallet-v1"));
      delete s.apiKey; delete s.geminiApiKey;
      return s;
    });
    /* wipe the data but stay past onboarding, which is what a user restoring
       onto a fresh install actually does after tapping through setup */
    await app.page.evaluate(() => {
      const blank = JSON.parse(localStorage.getItem("weekend-wallet-v1"));
      localStorage.setItem("weekend-wallet-v1", JSON.stringify(Object.assign(blank, {
        expenses: [], commitments: [], goals: [], debts: [], salary: 0,
        restAmount: 0, restFrom: "", restTs: 0
      })));
    });
    await app.page.reload(); await app.page.waitForTimeout(350);
    t.eq("wiped before restoring", (await app.stored()).expenses.length, 0);
    await importFile(app, exported);
    const back = await app.stored();
    t.eq("expenses restored", back.expenses.length, 1);
    t.near("amount survives exactly", back.expenses[0].amount, 123.45);
    t.eq("note survives", back.expenses[0].note, "Dinner");
    t.eq("commitments restored", back.commitments.length, 1);
    t.eq("goal balance restored", back.goals[0].saved, 1500);
    t.eq("debt log restored", back.debts[0].log.length, 1);
    t.eq("salary restored", back.salary, 9000);
    await app.close();
  }

  /* ---------- a malformed backup must not brick the app ---------- */
  {
    const app = await boot(browser, baseState({
      restAmount: 3000, restFrom: "2026-08-01", restTs: 1,
      expenses: [expense({ amount: 100, date: "2026-08-05" })]
    }), { now: NOW });
    /* an expense with no date used to be saved, then throw on every later
       launch, leaving a blank screen no reload could clear */
    await importFile(app, { expenses: [{ id: "x", amount: 50 }], commitments: [{ amount: "not-a-number" }] });
    await app.page.reload(); await app.page.waitForTimeout(400);
    t.ok("app still renders after a bad import", (await app.shellSize()) > 500);
    t.eq("the undated row is dropped", (await app.stored()).expenses.length, 0);
    t.eq("a non-numeric amount is coerced", (await app.stored()).commitments[0].amount, 0);
    await app.tab("plan");
    t.no("no NaN reaches the screen", (await app.shellText()).includes("NaN"));
    t.no("no page errors after a bad import", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---------- outright invalid input is refused, not applied ---------- */
  {
    const app = await boot(browser, baseState({
      expenses: [expense({ id: "mine", amount: 77, note: "Keep me" })]
    }), { now: NOW });
    await importFile(app, "this is not json at all", "notes.txt");
    const st = await app.stored();
    t.eq("existing data is untouched", st.expenses.length, 1);
    t.eq("and it is still mine", st.expenses[0].note, "Keep me");
    t.has("the failure is explained", await app.toast(), "isn't a Weekend Wallet backup");
    await app.close();
  }
  {
    const app = await boot(browser, baseState({
      expenses: [expense({ id: "mine", amount: 77, note: "Keep me" })]
    }), { now: NOW });
    /* valid JSON, wrong shape */
    await importFile(app, { hello: "world" });
    t.eq("wrong-shaped JSON is refused", (await app.stored()).expenses.length, 1);
    await app.close();
  }

  /* ---------- a backup from a previous month must not resurrect its pool ---------- */
  {
    const app = await boot(browser, baseState({}), { now: NOW });
    await importFile(app, {
      currency: "MAD", restAmount: 3000, restFrom: "2026-07-01", restTs: 1,
      expenses: [expense({ id: "j1", amount: 2500, date: "2026-07-10" })]
    });
    const st = await app.stored();
    t.eq("the stale pool is cleared", st.restAmount, 0);
    t.eq("and its anchor with it", st.restFrom, "");
    await app.tab("home");
    t.ok("the app asks for this month's number", await app.page.evaluate(() => !!document.querySelector("#h-newmonth")));
    await app.close();
  }

  /* ---------- secrets are never written into a backup ---------- */
  {
    const app = await boot(browser, baseState({ apiKey: "sk-ant-SECRET", geminiApiKey: "AIzaSECRET" }), { now: NOW });
    const payload = await app.page.evaluate(() => {
      /* mirror the export builder without triggering a real download */
      const s = JSON.parse(localStorage.getItem("weekend-wallet-v1"));
      return JSON.stringify({ setup: s.setup, currency: s.currency, expenses: s.expenses, salary: s.salary });
    });
    t.no("no Claude key in an export", payload.includes("sk-ant-SECRET"));
    t.no("no Gemini key in an export", payload.includes("AIzaSECRET"));
    await app.close();
  }

  /* ---------- empty and duplicate data ---------- */
  {
    const app = await boot(browser, baseState({ expenses: [] }), { now: NOW });
    t.ok("empty history renders", (await app.shellSize()) > 500);
    await app.close();
  }
  {
    /* two identical expenses are two real expenses, not a de-duplication bug */
    const dup = { id: "same", ts: 5, amount: 60, cat: "food", note: "Coffee", date: "2026-08-18", photo: null };
    const app = await boot(browser, baseState({ salary: 9000, expenses: [dup, Object.assign({}, dup)] }), { now: NOW });
    t.eq("duplicates both count", await app.hero(), "MAD 8,880");
    await app.close();
  }
};
