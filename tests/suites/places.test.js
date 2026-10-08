/* Fuel fill-ups and places.
   Fuel: consumption comes from litres and odometer readings, never from GPS.
   Places: location is read once when Add expense opens, only when switched
   on, and is matched against places the user named -- nothing is sent
   anywhere. The data checks matter most: the new expense fields must survive
   a relaunch and a backup, and deleting a place must never delete spending. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

const NOW = "2026-09-20T12:00:00";
const FOYER = { latitude: 34.0331, longitude: -5.0003, accuracy: 25 };
const CAFE = { latitude: 34.0500, longitude: -4.9800, accuracy: 20 };   /* ~3 km away */
const fills = () => [
  expense({ id: "f1", amount: 300, date: "2026-09-01", cat: "transport", note: "Afriquia", fuelLiters: 25, odometer: 10000 }),
  expense({ id: "f2", amount: 390, date: "2026-09-11", cat: "transport", note: "Shell", fuelLiters: 30, odometer: 10400 })
];
const foyerState = (extra) => baseState(Object.assign({
  salary: 9000, payday: 1, placesOn: 1,
  places: [{ id: "pfoyer", name: "Foyer", lat: FOYER.latitude, lng: FOYER.longitude, radius: 120, ts: 1 }],
  expenses: [
    expense({ id: "w1", amount: 6, date: "2026-09-02", cat: "drinks", note: "water", placeId: "pfoyer" }),
    expense({ id: "w2", amount: 12, date: "2026-09-05", cat: "drinks", note: "coffee", placeId: "pfoyer" }),
    expense({ id: "w3", amount: 8, date: "2026-09-09", cat: "drinks", note: "water", placeId: "pfoyer" }),
    expense({ id: "b1", amount: 20, date: "2026-09-10", cat: "out", note: "billiard", placeId: "pfoyer" })
  ]
}, extra || {}));
const at = async (app, where) => {
  await app.ctx.grantPermissions(["geolocation"]);
  await app.ctx.setGeolocation(where);
};
const openExpense = async app => {
  await app.page.click("#open-add");
  await app.page.waitForTimeout(250);
  await app.page.click("#qa-expense");
};
const sheetText = p => p.evaluate(() => document.querySelector("#sheet").innerText);

exports.name = "places · fuel fill-ups & location suggestions";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- fuel: consumption from fill-ups ---- */
  {
    const app = await boot(browser, baseState({ salary: 9000, payday: 1, expenses: fills() }), { now: NOW });
    await app.tab("plan");
    const card = norm(await app.page.evaluate(() => document.querySelector(".fuel-card").innerText));
    /* 30 L bought after the first reading, over 400 km */
    t.has("consumption from litres over distance", card, "7.5 L / 100 km");
    t.has("cost per km", card, "0.98");
    t.has("price per litre from the last fill-up", card, "13.00");
    t.has("this month's fuel", card, "MAD 690 · 2 fill-ups");
    /* 40 km a day for the 10 days left, at 0.975 a km */
    t.has("where the driving pace ends up", card, "about 400 km more by Sep 30");
    t.has("and what that costs", card, "≈ MAD 390");

    /* logging one from Plan */
    await app.page.click("#p-fuel-add");
    await app.page.waitForTimeout(350);
    t.ok("opens on Transport with the fill-up fields out", await app.page.evaluate(() =>
      document.querySelector('.chip[data-cat="transport"]').classList.contains("sel") && !document.querySelector("#f-fuel-fields").hidden));
    t.ok("the odometer hint shows the last reading", (await app.page.getAttribute("#f-odo", "placeholder")) === "last 10,400");
    await app.page.fill("#f-amount", "260");
    await app.page.fill("#f-liters", "20");
    await app.page.dispatchEvent("#f-liters", "input");
    t.has("price per litre while typing", norm(await sheetText(app.page)), "= 13.00 MAD per litre");
    await app.page.fill("#f-odo", "10650");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(400);
    let s = await app.stored();
    let f3 = s.expenses.find(e => e.odometer === 10650);
    t.ok("the fill-up is saved with litres and reading", f3 && f3.fuelLiters === 20 && f3.cat === "transport" && f3.amount === 260);
    await app.page.reload();
    await app.page.waitForTimeout(400);
    s = await app.stored();
    f3 = s.expenses.find(e => e.odometer === 10650);
    t.ok("and survives a relaunch", f3 && f3.fuelLiters === 20);
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- fuel: the form catches slips ---- */
  {
    const app = await boot(browser, baseState({ salary: 9000, payday: 1, expenses: fills() }), { now: NOW });
    await openExpense(app);
    await app.page.waitForTimeout(300);
    t.ok("the fill-up switch is hidden off Transport", await app.page.evaluate(() => document.querySelector("#f-fuel").hidden));
    await app.page.fill("#f-note", "afriquia");
    await app.page.dispatchEvent("#f-note", "input");
    t.ok("a station name switches to Transport and fuel", await app.page.evaluate(() =>
      document.querySelector('.chip[data-cat="transport"]').classList.contains("sel") && !document.querySelector("#f-fuel-fields").hidden));
    await app.page.fill("#f-amount", "200");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(250);
    t.has("litres are required for a fill-up", await app.toast(), "Enter the litres");
    await app.page.fill("#f-liters", "15");
    await app.page.fill("#f-odo", "9000");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(250);
    t.has("a reading below the last one is questioned", await app.toast(), "Lower than your last reading (10,400 km)");
    t.eq("and nothing is saved yet", (await app.stored()).expenses.length, 2);
    await app.page.click("#f-save");
    await app.page.waitForTimeout(400);
    t.eq("a second tap keeps it", (await app.stored()).expenses.length, 3);
    await app.close();
  }

  /* ---- places: at the foyer ---- */
  {
    const app = await boot(browser, foyerState(), { now: NOW });
    await at(app, FOYER);
    await openExpense(app);
    await app.page.waitForTimeout(800);
    const txt = norm(await sheetText(app.page));
    t.has("it knows where you are", txt, "At Foyer");
    t.ok("and picks what you usually buy there", await app.page.evaluate(() =>
      document.querySelector('#f-cats .chip[data-cat="drinks"]').classList.contains("sel")));
    t.has("with the rest one tap away", txt, "At Foyer Not here Drinks 3× Going out 1×");
    await app.page.click('.place-cats [data-cat="out"]');
    await app.page.fill("#f-amount", "20");
    await app.page.fill("#f-note", "billiard");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(400);
    const e = (await app.stored()).expenses.find(x => x.note === "billiard" && x.id !== "b1");
    t.ok("the expense is filed at the place, in the category chosen", e && e.placeId === "pfoyer" && e.cat === "out");
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- places: somewhere new ---- */
  {
    const app = await boot(browser, foyerState(), { now: NOW });
    await at(app, CAFE);
    await openExpense(app);
    await app.page.waitForTimeout(800);
    t.has("an unknown spot offers to be saved", norm(await sheetText(app.page)), "Somewhere new Save this place");
    t.ok("and does not pretend to be the foyer 3 km away", !/At Foyer/.test(await sheetText(app.page)));
    await app.page.click("#f-place-save");
    await app.page.fill("#f-place-name", "Café Clock");
    await app.page.dispatchEvent("#f-place-name", "input");
    await app.page.fill("#f-amount", "25");
    await app.page.click('#f-cats [data-cat="drinks"]');
    await app.page.click("#f-save");
    await app.page.waitForTimeout(400);
    const s = await app.stored();
    const cafe = s.places.find(p => p.name === "Café Clock");
    t.ok("the place is saved where you stood", cafe && Math.abs(cafe.lat - CAFE.latitude) < 1e-5 && Math.abs(cafe.lng - CAFE.longitude) < 1e-5);
    t.ok("with this expense in it", s.expenses.some(e => e.amount === 25 && e.placeId === cafe.id));
    await app.close();
  }

  /* ---- places: switched off, or refused, nothing is asked and nothing breaks ---- */
  {
    const app = await boot(browser, foyerState({ placesOn: 0 }), { now: NOW });
    await app.page.evaluate(() => {
      window.__asked = 0;
      const g = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      navigator.geolocation.getCurrentPosition = function(){ window.__asked++; return g.apply(null, arguments); };
    });
    await openExpense(app);
    await app.page.waitForTimeout(500);
    t.eq("switched off: location is never read", await app.page.evaluate(() => window.__asked), 0);
    t.no("and there is no place row", await app.page.evaluate(() => !!document.querySelector("#f-place")));
    await app.close();
  }
  {
    const app = await boot(browser, foyerState(), { now: NOW });
    /* what a phone answers after "Don't Allow" */
    await app.page.evaluate(() => {
      navigator.geolocation.getCurrentPosition = function(ok, fail){ setTimeout(() => fail({ code: 1 }), 50); };
    });
    await openExpense(app);
    await app.page.waitForTimeout(900);
    t.has("refused: it says so plainly", norm(await sheetText(app.page)), "Location is blocked");
    await app.page.fill("#f-amount", "10");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(400);
    t.ok("and the expense still saves", (await app.stored()).expenses.some(e => e.amount === 10 && !e.placeId));
    await app.close();
  }

  /* ---- Settings: the list, deleting, backups ---- */
  {
    const app = await boot(browser, foyerState(), { now: NOW });
    app.page.on("dialog", d => d.accept());
    await app.tab("settings");
    const panel = norm(await app.shellText());
    t.has("places are listed with what you buy there", panel, "Foyer 4 expenses · mostly Drinks");
    t.has("and the privacy terms are spelled out", panel, "never leaves this phone");
    await app.page.click('[data-place-del="pfoyer"]');
    await app.page.waitForTimeout(400);
    const s = await app.stored();
    t.eq("the place is gone", s.places.length, 0);
    t.eq("its expenses are all still there", s.expenses.length, 4);
    t.ok("just no longer pinned to it", s.expenses.every(e => !e.placeId));
    await app.close();
  }
  {
    /* a backup from another phone: places come in, the on/off switch does not */
    const app = await boot(browser, baseState({ salary: 1000 }), { now: NOW });
    app.page.on("dialog", d => d.accept());
    await app.tab("settings");
    const file = JSON.stringify(Object.assign(foyerState(), { expenses: foyerState().expenses.concat(fills()) }));
    await app.page.setInputFiles("#s-import-file", { name: "b.json", mimeType: "application/json", buffer: Buffer.from(file) });
    await app.page.waitForTimeout(600);
    const s = await app.stored();
    t.eq("places arrive with the backup", (s.places || []).map(p => p.name), ["Foyer"]);
    t.ok("expenses keep their place", s.expenses.filter(e => e.placeId === "pfoyer").length === 4);
    t.ok("fill-ups keep litres and readings", s.expenses.some(e => e.fuelLiters === 30 && e.odometer === 10400));
    t.eq("this phone's location switch is not overwritten by the file", s.placesOn, 0);
    await app.close();
  }
};
