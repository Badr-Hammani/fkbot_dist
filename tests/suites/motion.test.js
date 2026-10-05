/* Motion: screen entrances, the sliding tab pill, the 3D tile and coin bursts.
   None of it may cost anything real -- the page must open at the top, must
   never get wider than the phone while content slides in, must not replay an
   entrance on every re-render, and must stand completely still for anyone
   who asked their phone for reduced motion, without changing what is saved. */
"use strict";
const { boot, baseState, expense } = require("../harness");

const NOW = "2026-09-18T19:00:00";
const home = () => baseState({
  salary: 9000, payday: 1, restAmount: 1400, restFrom: "2026-09-16", restTs: Date.parse("2026-09-16T09:00:00"),
  expenses: [expense({ id: "a", amount: 120, date: "2026-09-17", cat: "food", note: "Lunch" })]
});

/* records every time #shell gains .enter, and the widest the page gets */
const watch = p => p.evaluate(() => {
  const shell = document.querySelector("#shell");
  window.__enters = 0; window.__maxW = 0;
  new MutationObserver(() => { if (shell.classList.contains("enter")) window.__enters++; })
    .observe(shell, { attributes: true, attributeFilter: ["class"] });
  (function f() {
    window.__maxW = Math.max(window.__maxW, document.documentElement.scrollWidth);
    requestAnimationFrame(f);
  })();
});
const seen = p => p.evaluate(() => ({ enters: window.__enters, maxW: window.__maxW }));

exports.name = "motion · transitions stay cosmetic";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- launch, switching screens, re-rendering ---- */
  {
    const app = await boot(browser, home(), { now: NOW, settle: 900 });
    const p = app.page;
    /* the harness opens onboarding first and then reloads -- exactly the case
       where Chrome restored a stale scroll anchor and opened Home 110px down */
    t.eq("the app opens at the top after a reload", await p.evaluate(() => scrollY), 0);
    t.ok("the brand tile is drawn in 3D", await p.evaluate(() => document.querySelectorAll(".bm3d .bm-layer").length >= 6));

    await watch(p);
    await p.click('[data-tab="plan"]');
    await p.waitForTimeout(700);
    let s = await seen(p);
    t.eq("switching screens plays the entrance once", s.enters, 1);
    t.ok("and the page never gets wider than the phone", s.maxW <= 390, "widest " + s.maxW + "px");
    t.ok("the pill ends under the active tab", await p.evaluate(() => {
      const a = document.querySelector(".tab.active").getBoundingClientRect();
      const i = document.querySelector(".tab-ind").getBoundingClientRect();
      return Math.abs(a.left - i.left) < 2 && Math.abs(a.width - i.width) < 2;
    }));
    await p.waitForTimeout(800);
    t.ok("the entrance clears itself", await p.evaluate(() => !document.querySelector("#shell").classList.contains("enter")));

    await p.click('[data-tab="home"]');
    await p.waitForTimeout(150);
    /* a same-screen re-render, mid entrance. A Playwright click would wait
       for the rising button to settle -- i.e. for the entrance to finish. */
    await p.evaluate(() => document.querySelector("#h-setup-hide").click());
    await p.waitForTimeout(100);
    t.ok("a re-render of the same screen cancels the entrance", await p.evaluate(() =>
      !document.querySelector("#shell").classList.contains("enter")));
    t.eq("without starting another one", (await seen(p)).enters, 2);
    t.eq("nothing threw", app.errors, []);
    await app.close();
  }

  /* ---- a coin burst is decoration: it cleans up after itself ---- */
  {
    const app = await boot(browser, home(), { now: NOW, settle: 900 });
    const p = app.page;
    p.on("dialog", d => d.accept());
    await app.tab("plan");
    await p.click("#p-salary-received");
    await p.waitForTimeout(120);
    t.ok("logging salary throws a few coins", await p.evaluate(() => document.querySelectorAll(".coin-burst .cb").length > 0));
    t.ok("which never catch a tap", await p.evaluate(() =>
      getComputedStyle(document.querySelector(".coin-burst")).pointerEvents === "none"));
    await p.waitForTimeout(1600);
    t.eq("and are gone afterwards", await p.evaluate(() => document.querySelectorAll(".coin-burst").length), 0);
    t.ok("the salary itself was saved", Object.keys((await app.stored()).salaryReceived || {}).length === 1);
    await app.close();
  }

  /* ---- reduced motion: same app, standing still ---- */
  {
    const app = await boot(browser, null, { now: NOW });
    const p = app.page;
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.evaluate(s => localStorage.setItem("weekend-wallet-v1", JSON.stringify(s)), home());
    await p.reload();
    await p.waitForTimeout(500);
    await watch(p);
    p.on("dialog", d => d.accept());
    await app.tab("plan");
    t.eq("no entrance plays", (await seen(p)).enters, 0);
    t.ok("the brand tile holds still", await p.evaluate(() =>
      getComputedStyle(document.querySelector(".bm3d")).animationName === "none"));
    t.ok("the background does not drift", await p.evaluate(() =>
      getComputedStyle(document.body, "::before").animationName === "none"));
    t.ok("the pill still sits under the active tab", await p.evaluate(() => {
      const a = document.querySelector(".tab.active").getBoundingClientRect();
      const i = document.querySelector(".tab-ind").getBoundingClientRect();
      return Math.abs(a.left - i.left) < 2;
    }));
    await p.click("#p-salary-received");
    await p.waitForTimeout(120);
    t.eq("no coins fly", await p.evaluate(() => document.querySelectorAll(".coin-burst").length), 0);
    t.ok("but the salary is saved just the same", Object.keys((await app.stored()).salaryReceived || {}).length === 1);
    t.eq("nothing threw", app.errors, []);
    await app.close();
  }
};
