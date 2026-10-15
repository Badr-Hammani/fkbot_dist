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

    await app.page.click('[data-inbox-add="g1"]');
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
    t.has("with what to do", txt, "add only one");
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
};
