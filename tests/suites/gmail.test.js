/* Gmail reader — pure Node with a fake fetch. No browser, no real network.
   Covers the OAuth redirect parsing (CSRF guard), query building, pagination,
   MIME walking + UTF-8 decoding, concurrency and error-code mapping. */
"use strict";
const path = require("path");
const { APP_DIR } = require("../harness");

function lib() {
  const p = path.join(APP_DIR, "gmail.js");
  delete require.cache[require.resolve(p)];
  return require(p);
}

/* base64url without padding, the way Gmail sends body.data */
function b64u(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const TOKEN = "ya29.SECRET-token_value";

exports.name = "gmail · read-only sync";
exports.run = async function (t) {
  const G = lib();

  /* ---------- authUrl ---------- */
  t.eq("SCOPE is gmail.readonly", G.SCOPE, "https://www.googleapis.com/auth/gmail.readonly");
  const au = new URL(G.authUrl({
    clientId: "123-abc.apps.googleusercontent.com",
    redirectUri: "https://badr-hammani.github.io/fkbot_dist/weekend-wallet/",
    state: "st&ate=1", loginHint: "me+x@gmail.com", prompt: "consent"
  }));
  t.eq("authUrl endpoint", au.origin + au.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  t.eq("authUrl response_type=token", au.searchParams.get("response_type"), "token");
  t.eq("authUrl scope", au.searchParams.get("scope"), G.SCOPE);
  t.eq("authUrl asks for nothing beyond Gmail read-only", au.searchParams.get("include_granted_scopes"), null);
  t.eq("authUrl redirect_uri round-trips", au.searchParams.get("redirect_uri"), "https://badr-hammani.github.io/fkbot_dist/weekend-wallet/");
  t.eq("authUrl state with & and = encoded", au.searchParams.get("state"), "st&ate=1");
  t.eq("authUrl login_hint with + encoded", au.searchParams.get("login_hint"), "me+x@gmail.com");
  t.eq("authUrl prompt", au.searchParams.get("prompt"), "consent");
  const bare = new URL(G.authUrl({ clientId: "c", redirectUri: "https://x/", state: "s" }));
  t.no("authUrl omits login_hint/prompt when absent", bare.searchParams.has("login_hint") || bare.searchParams.has("prompt"));

  /* ---------- newState ---------- */
  const s1 = G.newState(), s2 = G.newState();
  t.ok("newState is 32+ url-safe chars", /^[A-Za-z0-9_-]{32,}$/.test(s1), s1);
  t.ok("newState is random", s1 !== s2);

  /* ---------- readRedirect ---------- */
  const NOW = 1760000000000;
  const scopeStr = encodeURIComponent("email " + G.SCOPE);
  const okHash = "#access_token=" + encodeURIComponent(TOKEN) + "&token_type=Bearer&expires_in=3599&scope=" + scopeStr + "&state=abc123";
  const rr = G.readRedirect(okHash, "abc123", NOW);
  t.eq("readRedirect token", rr && rr.token, TOKEN);
  t.eq("readRedirect expiresAt = now + (expires_in-60)s", rr && rr.expiresAt, NOW + 3539000);
  t.eq("readRedirect state mismatch rejected", JSON.stringify(G.readRedirect(okHash, "zzz", NOW)), '{"error":"state"}');
  t.eq("readRedirect missing state rejected",
    JSON.stringify(G.readRedirect("#access_token=x&expires_in=3599&scope=" + scopeStr, "abc123", NOW)), '{"error":"state"}');
  t.eq("readRedirect no expected state → rejected", JSON.stringify(G.readRedirect(okHash, "", NOW)), '{"error":"state"}');
  t.eq("readRedirect access_denied", JSON.stringify(G.readRedirect("#error=access_denied&state=abc123", "abc123", NOW)), '{"error":"access_denied"}');
  t.eq("readRedirect error with bad state → state",
    JSON.stringify(G.readRedirect("#error=access_denied&state=evil", "abc123", NOW)), '{"error":"state"}');
  t.eq("readRedirect scope missing gmail.readonly",
    JSON.stringify(G.readRedirect("#access_token=x&expires_in=3599&scope=email%20profile&state=abc123", "abc123", NOW)), '{"error":"scope"}');
  t.ok("readRedirect non-oauth hash → null", G.readRedirect("#tab=home", "abc123", NOW) === null);
  t.ok("readRedirect empty hash → null", G.readRedirect("", "abc123", NOW) === null);

  /* ---------- buildQuery ---------- */
  const q = G.buildQuery({
    afterSec: 1760000000,
    senders: [{ domains: ["cihbank.ma", "attijariwafa.com"] }, { domains: ["glovoapp.com"] }],
    keywords: ["reçu", "paiement effectué", "facture"]
  });
  t.eq("buildQuery full", q,
    'after:1760000000 ({from:cihbank.ma from:attijariwafa.com from:glovoapp.com} OR subject:{reçu "paiement effectué" facture}) -in:chats -in:spam -in:trash');
  t.eq("buildQuery without afterSec / keywords",
    G.buildQuery({ afterSec: 0, senders: [{ domains: ["a.com"] }] }), "({from:a.com}) -in:chats -in:spam -in:trash");

  /* ---------- listIds ---------- */
  const calls = [];
  const pages = {
    "": { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }], nextPageToken: "P2" },
    P2: { messages: [{ id: "m4" }, { id: "m5" }, { id: "m6" }], nextPageToken: "P3" },
    P3: { messages: [{ id: "m7" }] }
  };
  const listFetch = (url, init) => {
    calls.push({ url, init });
    const pt = new URL(url).searchParams.get("pageToken") || "";
    return Promise.resolve(jsonRes(200, pages[pt]));
  };
  const all = await G.listIds(TOKEN, "after:1 -in:spam", { max: 100, fetch: listFetch });
  t.eq("listIds follows nextPageToken, newest first", all.join(","), "m1,m2,m3,m4,m5,m6,m7");
  t.eq("listIds made 3 page requests", calls.length, 3);
  t.ok("listIds sends Authorization: Bearer", calls.every(c => c.init.headers.Authorization === "Bearer " + TOKEN));
  t.ok("token never appears in any URL", calls.every(c => c.url.indexOf(TOKEN) < 0 && c.url.indexOf("ya29") < 0));
  t.ok("listIds hits gmail.googleapis.com with q", calls[0].url.indexOf("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=") === 0
    && new URL(calls[0].url).searchParams.get("q") === "after:1 -in:spam", calls[0].url);
  calls.length = 0;
  const four = await G.listIds(TOKEN, "x", { max: 4, fetch: listFetch });
  t.eq("listIds stops at max", four.join(","), "m1,m2,m3,m4");
  t.eq("listIds asks only for what remains", new URL(calls[1].url).searchParams.get("maxResults"), "1");

  let askedMax = 0;
  const bigFetch = (url) => {
    const u = new URL(url);
    askedMax = Math.max(askedMax, +u.searchParams.get("maxResults"));
    const n = +(u.searchParams.get("pageToken") || 0);
    const msgs = [];
    for (let i = 0; i < 100; i++) msgs.push({ id: "x" + (n * 100 + i) });
    return Promise.resolve(jsonRes(200, { messages: msgs, nextPageToken: String(n + 1) }));
  };
  const capped = await G.listIds(TOKEN, "x", { max: 5000, fetch: bigFetch });
  t.eq("listIds hard cap 200", capped.length, 200);
  t.ok("listIds never asks for more than 200", askedMax <= 200, askedMax);
  t.eq("listIds default max 50", (await G.listIds(TOKEN, "x", { fetch: bigFetch })).length, 50);

  /* ---------- getMessage ---------- */
  const accents = "Montant : 1 234,50 € — café à Fès, reçu ç";
  const html = "<p>Total <b>89,90 €</b> — déjà payé</p>";
  /* force "-" and "_" into the encoded data: these bytes encode to ">>>" / "???" in base64 */
  const urlish = "a>>>b???c";
  const full = {
    id: "m1", threadId: "t1", snippet: "Montant 1 234,50", internalDate: "1760000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "FROM", value: "CIH Bank <alerts@cihbank.ma>" }, { name: "subject", value: "Reçu de paiement" },
                { name: "Date", value: "Thu, 09 Oct 2025 08:53:20 +0000" }],
      parts: [
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64u(accents) } },
          { mimeType: "multipart/related", parts: [
            { mimeType: "text/html", body: { data: b64u(html) } }
          ] }
        ] },
        { mimeType: "text/plain", body: { data: b64u(urlish) } },
        { mimeType: "text/plain", filename: "statement.txt", body: { data: b64u("ATTACHMENT-LEAK") } },
        { mimeType: "application/pdf", filename: "receipt.pdf", body: { attachmentId: "att1", size: 1234 } }
      ]
    }
  };
  t.ok("fixture really contains - and _", /-/.test(b64u(urlish)) && /_/.test(b64u(urlish)) && !/=/.test(b64u(accents)), b64u(urlish));
  let gotUrl = "", gotAuth = "";
  const msg = await G.getMessage(TOKEN, "m1", { fetch: (url, init) => { gotUrl = url; gotAuth = init.headers.Authorization; return Promise.resolve(jsonRes(200, full)); } });
  t.eq("getMessage URL", gotUrl, "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full");
  t.eq("getMessage Authorization header", gotAuth, "Bearer " + TOKEN);
  t.ok("UTF-8 accents survive (é ç € à)", msg.text.indexOf(accents) === 0, msg.text);
  t.ok("base64url - and _ decoded", msg.text.indexOf(urlish) >= 0, msg.text);
  t.eq("nested text/html found", msg.html, html);
  t.no("attachment text skipped", msg.text.indexOf("ATTACHMENT-LEAK") >= 0);
  t.eq("header lookup case-insensitive (FROM)", msg.from, "CIH Bank <alerts@cihbank.ma>");
  t.eq("subject with accent", msg.subject, "Reçu de paiement");
  t.eq("internalDate → ISO", msg.date, new Date(1760000000000).toISOString());
  t.eq("id/threadId/snippet", [msg.id, msg.threadId, msg.snippet].join("|"), "m1|t1|Montant 1 234,50");
  const noInternal = await G.getMessage(TOKEN, "m9", { fetch: () => Promise.resolve(jsonRes(200,
    { id: "m9", payload: { mimeType: "text/plain", headers: [{ name: "date", value: "Thu, 09 Oct 2025 08:53:20 +0000" }], body: { data: b64u("x") } } })) });
  t.eq("Date header fallback → ISO", noInternal.date, "2025-10-09T08:53:20.000Z");
  t.eq("single-part body", noInternal.text, "x");
  t.eq("latin-1 charset honoured", G._decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64"), "ISO-8859-1"), "café");
  t.eq("manual UTF-8 fallback decoder", G._utf8Decode(Array.from(Buffer.from("é ç € à 😀", "utf8"))), "é ç € à 😀");
  t.eq("manual decoder replaces invalid bytes", G._utf8Decode([0x61, 0xc3, 0x28, 0x62]), "a�(b");

  /* ---------- fetchNew ---------- */
  function makeFetch(ids, behave) {
    const st = { inFlight: 0, maxInFlight: 0, got: [] };
    st.fetch = (url) => {
      const u = new URL(url);
      if (/\/messages$/.test(u.pathname)) return Promise.resolve(jsonRes(200, { messages: ids.map(id => ({ id })) }));
      const id = decodeURIComponent(u.pathname.split("/").pop());
      st.got.push(id);
      st.inFlight++;
      st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
      return new Promise(r => setTimeout(r, 5 + (id.charCodeAt(id.length - 1) % 4) * 3)).then(() => {
        st.inFlight--;
        const b = behave && behave(id);
        if (b) return b;
        return jsonRes(200, { id, threadId: "t", internalDate: "1760000000000", payload: { mimeType: "text/plain", body: { data: b64u("body " + id) } } });
      });
    };
    return st;
  }
  const ids10 = ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"];
  const f1 = makeFetch(ids10);
  const fresh = await G.fetchNew(TOKEN, { query: "q", knownIds: { n1: true, n4: 1 }, fetch: f1.fetch, concurrency: 3 });
  t.eq("fetchNew skips knownIds (map), keeps newest-first order", fresh.map(m => m.id).join(","), "n0,n2,n3,n5,n6,n7,n8,n9");
  t.no("fetchNew never fetched a known id", f1.got.indexOf("n1") >= 0 || f1.got.indexOf("n4") >= 0);
  t.ok("fetchNew respects concurrency (≤3 in flight)", f1.maxInFlight <= 3 && f1.maxInFlight >= 2, f1.maxInFlight);
  const f1b = makeFetch(ids10);
  await G.fetchNew(TOKEN, { query: "q", fetch: f1b.fetch });
  t.ok("fetchNew default concurrency 4", f1b.maxInFlight === 4, f1b.maxInFlight);
  const f2 = makeFetch(ids10, id => id === "n3" ? jsonRes(500, { error: { code: 500, message: "Backend Error" } }) : null);
  const partial = await G.fetchNew(TOKEN, { query: "q", knownIds: ["n9"], fetch: f2.fetch });
  t.eq("fetchNew skips a single 500 + knownIds array", partial.map(m => m.id).join(","), "n0,n1,n2,n4,n5,n6,n7,n8");
  const f3 = makeFetch(ids10, id => id === "n2" ? jsonRes(401, { error: { code: 401, message: "Invalid Credentials" } }) : null);
  let abort = null;
  try { await G.fetchNew(TOKEN, { query: "q", fetch: f3.fetch }); } catch (e) { abort = e; }
  t.eq("fetchNew aborts on 401 with code auth", abort && abort.code, "auth");
  t.eq("fetchNew with nothing new → []", (await G.fetchNew(TOKEN, { query: "q", knownIds: ids10, fetch: makeFetch(ids10).fetch })).length, 0);

  /* ---------- fetchNew: failures are reported, not lost ---------- */
  const ids5 = ["a0", "a1", "a2", "a3", "a4"];
  const f4 = makeFetch(ids5, id => id === "a2" ? jsonRes(500, { error: { code: 500, message: "Backend Error" } }) : null);
  const r4 = await G.fetchNew(TOKEN, { query: "q", fetch: f4.fetch });
  t.eq("one 500 among 5 → other 4 returned", r4.map(m => m.id).join(","), "a0,a1,a3,a4");
  t.eq("one 500 among 5 → failed lists it", (r4.failed || []).join(","), "a2");
  t.eq("result.listed = unknown ids listed", r4.listed, 5);
  t.eq("result.more false when listing exhausted", r4.more, false);
  t.ok("result still a real array (forEach/length)", Array.isArray(r4) && typeof r4.forEach === "function" && r4.length === 4);
  const r4k = await G.fetchNew(TOKEN, { query: "q", knownIds: ["a0", "a1"], fetch: makeFetch(ids5).fetch });
  t.eq("listed excludes knownIds", r4k.listed, 3);
  t.eq("failed is [] when all succeed", JSON.stringify(r4k.failed), "[]");
  const f5 = makeFetch(ids5, id => jsonRes(503, { error: { code: 503, message: "Unavailable" } }));
  let allFail = null;
  try { await G.fetchNew(TOKEN, { query: "q", fetch: f5.fetch }); } catch (e) { allFail = e; }
  t.eq("all downloads fail → rejects with first error (http)", allFail && allFail.code, "http");
  const f6 = makeFetch(ids5, id => Promise.reject(new TypeError("Failed to fetch")));
  let allNet = null;
  try { await G.fetchNew(TOKEN, { query: "q", fetch: f6.fetch }); } catch (e) { allNet = e; }
  t.eq("all downloads offline → rejects network", allNet && allNet.code, "network");
  const none = await G.fetchNew(TOKEN, { query: "q", knownIds: ids5, fetch: makeFetch(ids5).fetch });
  t.ok("nothing new is a success with empty failed", none.length === 0 && none.failed.length === 0 && none.listed === 0);

  /* ---------- fetchNew pages past known mail ---------- */
  function pagedFetch(total, perPageCap) {
    const st = { pages: 0, sizes: [], got: [] };
    st.fetch = (url) => {
      const u = new URL(url);
      if (/\/messages$/.test(u.pathname)) {
        st.pages++;
        const size = Math.min(+u.searchParams.get("maxResults"), perPageCap || 1e9);
        st.sizes.push(+u.searchParams.get("maxResults"));
        const start = +(u.searchParams.get("pageToken") || 0);
        const msgs = [];
        for (let i = start; i < Math.min(total, start + size); i++) msgs.push({ id: "g" + i });
        const body = { messages: msgs };
        if (start + size < total) body.nextPageToken = String(start + size);
        return Promise.resolve(jsonRes(200, body));
      }
      const id = u.pathname.split("/").pop();
      st.got.push(id);
      return Promise.resolve(jsonRes(200, { id, payload: { mimeType: "text/plain", body: { data: b64u(id) } } }));
    };
    return st;
  }
  const known60 = {};
  for (let i = 0; i < 60; i++) known60["g" + i] = true;
  const pf = pagedFetch(250, 50);
  const older = await G.fetchNew(TOKEN, { query: "q", max: 60, knownIds: known60, fetch: pf.fetch });
  t.eq("250 ids, newest 60 known → next 60 unknown", older.map(m => m.id).join(","),
    Array.from({ length: 60 }, (_, i) => "g" + (60 + i)).join(","));
  t.eq("… with more=true", older.more, true);
  t.no("… never downloads a known id", pf.got.some(id => known60[id]));
  t.ok("listing asks ≤100 per page", pf.sizes.every(n => n > 0 && n <= 100), pf.sizes.join(","));
  t.eq("… listed counts unknown ids seen", older.listed, 90);
  const known250 = {};
  for (let i = 0; i < 2000; i++) known250["g" + i] = true;
  const cap = pagedFetch(2000);
  const capped10 = await G.fetchNew(TOKEN, { query: "q", max: 60, knownIds: known250, fetch: cap.fetch });
  t.eq("page cap: stops after 10 listing pages", cap.pages, 10);
  t.ok("page cap: empty result, more=true", capped10.length === 0 && capped10.more === true);
  const cap2 = pagedFetch(1050);
  const k2 = {};
  for (let i = 0; i < 1000; i++) k2["g" + i] = true;
  const after10 = await G.fetchNew(TOKEN, { query: "q", max: 60, knownIds: k2, fetch: cap2.fetch });
  t.ok("page cap: unknown ids beyond page 10 not reached", after10.length === 0 && after10.more === true && cap2.pages === 10, cap2.pages);

  /* ---------- error mapping ---------- */
  async function codeFor(res) {
    try { await G.listIds(TOKEN, "q", { fetch: () => res }); return "resolved"; } catch (e) { return e; }
  }
  const e401 = await codeFor(Promise.resolve(jsonRes(401, { error: { code: 401, message: "Request had invalid authentication credentials." } })));
  t.eq("401 → auth", e401.code, "auth");
  const e403scope = await codeFor(Promise.resolve(jsonRes(403, { error: { code: 403, message: "Request had insufficient authentication scopes.",
    errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } })));
  t.eq("403 insufficientPermissions → auth", e403scope.code, "auth");
  const notEnabled = "Gmail API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123";
  const e403 = await codeFor(Promise.resolve(jsonRes(403, { error: { code: 403, message: notEnabled,
    errors: [{ reason: "accessNotConfigured" }], status: "PERMISSION_DENIED" } })));
  t.eq("403 API not enabled → forbidden", e403.code, "forbidden");
  t.has("forbidden carries Google's message", e403.message, "Gmail API has not been used");
  const e429 = await codeFor(Promise.resolve(jsonRes(429, { error: { code: 429, message: "Too many" } })));
  t.eq("429 → rate", e429.code, "rate");
  const eNet = await codeFor(Promise.reject(new TypeError("Failed to fetch")));
  t.eq("fetch rejection → network", eNet.code, "network");
  const e502 = await codeFor(Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError("html")) }));
  t.eq("502 non-JSON → http", e502.code, "http");
  t.eq("http error keeps .status", e502.status, 502);
  t.ok("errors are Error instances", e401 instanceof Error && eNet instanceof Error);
  t.no("token not leaked in error messages", [e401, e403, e429, eNet, e502].some(e => String(e.message).indexOf(TOKEN) >= 0));

  /* getProfile: the address for login_hint, validated */
  {
    let seen = "";
    const f = (url, init) => { seen = url + " " + (init && init.headers && init.headers.Authorization);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ emailAddress: "badr@gmail.com" }) }); };
    const p = await G.getProfile("tok", { fetch: f });
    t.eq("getProfile returns the address", p.email, "badr@gmail.com");
    t.ok("from users/me/profile, token in the header only", /\/users\/me\/profile Bearer tok$/.test(seen), seen);
    const bad = await G.getProfile("tok", { fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ emailAddress: "<x>@y" }) }) });
    t.eq("a malformed address is dropped", bad.email, "");
  }
};
