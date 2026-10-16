/* Gmail reader — dependency-free, client-side, read-only.
   OAuth 2.0 implicit (token) flow by full-page redirect (popups are unreliable
   in iOS standalone web apps), then plain fetch to the Gmail REST API.
   No Google script tags. The token is never logged, persisted or put in a URL
   by this module: it only travels in the Authorization header to
   gmail.googleapis.com. Storage is the app's decision.
   Loaded by index.html and testable in Node (module.exports guard at the bottom). */
(function (root) {
  "use strict";

  var SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  var AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
  var API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  var DEFAULT_MAX = 50;
  var HARD_MAX = 200;

  /* ---------- small helpers ---------- */

  function err(code, message, status) {
    var e = new Error(message || code);
    e.code = code;
    if (status != null) e.status = status;
    return e;
  }

  /* Taken once, when this file loads: a script injected later that wraps
     window.fetch must not get to see the Bearer token. */
  var nativeFetch = root && typeof root.fetch === "function" ? root.fetch.bind(root)
                  : (typeof fetch === "function" ? fetch : null);
  function pickFetch(opts) {
    var f = opts && opts.fetch;
    if (typeof f === "function") return f;
    return nativeFetch;
  }

  function getCrypto() {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") return crypto;
    if (root && root.crypto && typeof root.crypto.getRandomValues === "function") return root.crypto;
    return null;
  }

  /* ---------- OAuth ---------- */

  function authUrl(o) {
    o = o || {};
    if (!o.clientId) throw err("config", "clientId is required");
    if (!o.redirectUri) throw err("config", "redirectUri is required");
    var p = [
      ["response_type", "token"],
      ["client_id", o.clientId],
      ["redirect_uri", o.redirectUri],
      ["scope", SCOPE],
      ["state", o.state == null ? "" : o.state]
    ];
    if (o.loginHint) p.push(["login_hint", o.loginHint]);
    if (o.prompt) p.push(["prompt", o.prompt]);
    return AUTH_ENDPOINT + "?" + p.map(function (kv) {
      return encodeURIComponent(kv[0]) + "=" + encodeURIComponent(String(kv[1]));
    }).join("&");
  }

  function newState() {
    var n = 24, bytes = [], i;
    var c = getCrypto();
    if (c) {
      var a = new Uint8Array(n);
      c.getRandomValues(a);
      for (i = 0; i < n; i++) bytes.push(a[i]);
    } else {
      for (i = 0; i < n; i++) bytes.push(Math.floor(Math.random() * 256));
    }
    return bytes.map(function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
  }

  function parseParams(s) {
    var out = {};
    String(s || "").split("&").forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf("=");
      var k = i < 0 ? pair : pair.slice(0, i);
      var v = i < 0 ? "" : pair.slice(i + 1);
      try {
        k = decodeURIComponent(k.replace(/\+/g, " "));
        v = decodeURIComponent(v.replace(/\+/g, " "));
      } catch (e) { return; }
      out[k] = v;
    });
    return out;
  }

  function readRedirect(hash, expectedState, nowMs) {
    var s = String(hash || "");
    if (s.charAt(0) === "#") s = s.slice(1);
    var p = parseParams(s);
    var has = Object.prototype.hasOwnProperty;
    if (!has.call(p, "access_token") && !has.call(p, "error")) return null;
    /* CSRF guard: nothing — token or error — is trusted without a matching state */
    if (!expectedState || !p.state || p.state !== String(expectedState)) return { error: "state" };
    if (has.call(p, "error")) return { error: p.error || "unknown" };
    if (!p.access_token) return { error: "unknown" };
    var scopes = String(p.scope || "").split(/[\s,]+/);
    if (scopes.indexOf(SCOPE) < 0) return { error: "scope" };
    var exp = parseInt(p.expires_in, 10);
    if (!(exp > 0)) exp = 3599;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    return { token: p.access_token, expiresAt: now + (exp - 60) * 1000 };
  }

  /* ---------- search query ---------- */

  /* Strip characters that are Gmail search syntax so a keyword can't break the query. */
  function cleanTerm(s) {
    return String(s == null ? "" : s).replace(/["{}()]/g, " ").replace(/\s+/g, " ").trim();
  }

  function buildQuery(o) {
    o = o || {};
    var parts = [];
    var after = Math.floor(Number(o.afterSec));
    if (o.afterSec && after > 0) parts.push("after:" + after);

    var seen = {}, froms = [];
    (o.senders || []).forEach(function (sn) {
      ((sn && sn.domains) || []).forEach(function (d) {
        d = cleanTerm(d).replace(/\s/g, "").toLowerCase();
        if (d && !seen[d]) { seen[d] = 1; froms.push("from:" + d); }
      });
    });

    var kws = [], seenK = {};
    (o.keywords || []).forEach(function (k) {
      k = cleanTerm(k);
      if (!k || seenK[k.toLowerCase()]) return;
      seenK[k.toLowerCase()] = 1;
      kws.push(/\s/.test(k) ? '"' + k + '"' : k);
    });

    var alts = [];
    if (froms.length) alts.push("{" + froms.join(" ") + "}");
    if (kws.length) alts.push("subject:{" + kws.join(" ") + "}");
    if (alts.length) parts.push("(" + alts.join(" OR ") + ")");

    parts.push("-in:chats", "-in:spam", "-in:trash");
    return parts.join(" ");
  }

  /* ---------- HTTP ---------- */

  function failFromResponse(res) {
    var status = res.status;
    var bodyP;
    try { bodyP = Promise.resolve(res.json()); } catch (e) { bodyP = Promise.resolve(null); }
    return bodyP.then(null, function () { return null; }).then(function (body) {
      var ge = (body && body.error) || {};
      var msg = typeof ge === "string" ? ge : (ge.message || "");
      var reasons = [];
      (ge.errors || []).forEach(function (x) { if (x && x.reason) reasons.push(String(x.reason)); });
      (ge.details || []).forEach(function (x) { if (x && x.reason) reasons.push(String(x.reason)); });
      var rs = reasons.join(" ");
      if (status === 401) throw err("auth", msg || "Not signed in to Gmail", 401);
      if (status === 403) {
        if (/authError|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(rs) ||
            /invalid (authentication|credentials|token)|insufficient authentication scopes/i.test(msg)) {
          throw err("auth", msg || "Gmail permission missing", 403);
        }
        if (/rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(rs)) {
          throw err("rate", msg || "Gmail rate limit", 403);
        }
        throw err("forbidden", msg || "Gmail refused the request", 403);
      }
      if (status === 429) throw err("rate", msg || "Gmail rate limit", 429);
      throw err("http", msg || ("Gmail HTTP " + status), status);
    });
  }

  function getJson(token, url, opts) {
    var f = pickFetch(opts);
    if (!f) return Promise.reject(err("network", "fetch is not available"));
    if (!token) return Promise.reject(err("auth", "No Gmail token"));
    var p;
    try {
      p = Promise.resolve(f(url, {
        method: "GET",
        headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      }));
    } catch (e) { p = Promise.reject(e); }
    return p.then(function (res) {
      if (!res || !res.ok) {
        if (!res) throw err("network", "No response");
        return failFromResponse(res);
      }
      return Promise.resolve(res.json()).then(null, function () {
        throw err("http", "Gmail returned an unreadable response", res.status);
      });
    }, function (e) {
      throw err("network", (e && e.message) || "Network error");
    });
  }

  function listIds(token, query, opts) {
    opts = opts || {};
    var max = Math.floor(Number(opts.max));
    if (!(max > 0)) max = DEFAULT_MAX;
    if (max > HARD_MAX) max = HARD_MAX;
    var ids = [], seen = {};

    function page(pageToken) {
      var url = API + "?q=" + encodeURIComponent(query || "") +
        "&maxResults=" + Math.min(max - ids.length, 500);
      if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
      return getJson(token, url, opts).then(function (j) {
        ((j && j.messages) || []).forEach(function (m) {
          if (ids.length < max && m && m.id && !seen[m.id]) { seen[m.id] = 1; ids.push(m.id); }
        });
        if (ids.length < max && j && j.nextPageToken && j.nextPageToken !== pageToken) {
          return page(j.nextPageToken);
        }
        return ids;
      });
    }
    return page(null);
  }

  /* ---------- body decoding ---------- */

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var B64MAP = {};
  for (var bi = 0; bi < B64.length; bi++) B64MAP[B64.charAt(bi)] = bi;
  B64MAP["-"] = 62; B64MAP["_"] = 63;

  /* base64 or base64url, padding optional → array of byte values */
  function b64ToBytes(s) {
    s = String(s || "").replace(/[^A-Za-z0-9+/\-_]/g, "");
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      buf = (buf << 6) | B64MAP[s.charAt(i)];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
      }
      buf &= (1 << bits) - 1; /* keep only the bits not yet emitted */
    }
    return out;
  }

  function codesToString(codes) {
    var s = "", CH = 8192;
    for (var i = 0; i < codes.length; i += CH) s += String.fromCharCode.apply(null, codes.slice(i, i + CH));
    return s;
  }

  /* Manual UTF-8 → string, for engines without TextDecoder. Invalid → U+FFFD. */
  function utf8Decode(bytes) {
    var codes = [], i = 0, n = bytes.length;
    while (i < n) {
      var b = bytes[i], cp = -1, need = 0, min = 0;
      if (b < 0x80) { codes.push(b); i++; continue; }
      if (b >= 0xc2 && b <= 0xdf) { cp = b & 0x1f; need = 1; min = 0x80; }
      else if (b >= 0xe0 && b <= 0xef) { cp = b & 0x0f; need = 2; min = 0x800; }
      else if (b >= 0xf0 && b <= 0xf4) { cp = b & 0x07; need = 3; min = 0x10000; }
      else { codes.push(0xfffd); i++; continue; }
      var j = 1;
      for (; j <= need; j++) {
        var c = bytes[i + j];
        if (c === undefined || (c & 0xc0) !== 0x80) break;
        cp = (cp << 6) | (c & 0x3f);
      }
      if (j <= need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        codes.push(0xfffd); i += Math.max(1, j); continue;
      }
      i += need + 1;
      if (cp >= 0x10000) {
        cp -= 0x10000;
        codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else codes.push(cp);
    }
    return codesToString(codes);
  }

  function decodeBytes(bytes, charset) {
    var cs = String(charset || "utf-8").toLowerCase().replace(/^["']|["']$/g, "");
    if (typeof TextDecoder === "function") {
      try { return new TextDecoder(cs).decode(new Uint8Array(bytes)); } catch (e) { /* unknown label */ }
      try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); } catch (e2) { /* fall through */ }
    }
    if (/^(iso-8859-1|latin1|latin-1|windows-1252|cp1252|us-ascii|ascii)$/.test(cs)) return codesToString(bytes);
    return utf8Decode(bytes);
  }

  function decodeBody(data, charset) {
    return decodeBytes(b64ToBytes(data), charset);
  }

  /* ---------- messages ---------- */

  function headerMap(headers) {
    var h = {};
    (headers || []).forEach(function (x) {
      if (!x || !x.name) return;
      var k = String(x.name).toLowerCase();
      if (!(k in h)) h[k] = String(x.value == null ? "" : x.value);
    });
    return h;
  }

  function charsetOf(part) {
    var ct = headerMap(part.headers)["content-type"] || "";
    var m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
    return m ? m[1] : "utf-8";
  }

  function walk(part, acc) {
    if (!part) return;
    var h = headerMap(part.headers);
    var isAttachment = !!part.filename || /^\s*attachment/i.test(h["content-disposition"] || "");
    if (isAttachment) return;
    var mt = String(part.mimeType || "").toLowerCase();
    if (part.parts && part.parts.length) {
      part.parts.forEach(function (p) { walk(p, acc); });
      return;
    }
    var data = part.body && part.body.data;
    if (!data) return; /* empty, or a large body held by attachmentId */
    /* a 14 MB body is not a receipt: only the first ~450 KB is ever decoded */
    if (data.length > 600000) data = data.slice(0, 600000);
    if (mt === "text/plain") acc.text.push(decodeBody(data, charsetOf(part)));
    else if (mt === "text/html") acc.html.push(decodeBody(data, charsetOf(part)));
  }

  function toMessage(j) {
    j = j || {};
    var payload = j.payload || {};
    var h = headerMap(payload.headers);
    var acc = { text: [], html: [] };
    walk(payload, acc);
    var date = "";
    var ms = Number(j.internalDate);
    if (j.internalDate != null && isFinite(ms) && ms > 0) date = new Date(ms).toISOString();
    else if (h.date) {
      var d = new Date(h.date);
      if (!isNaN(d.getTime())) date = d.toISOString();
    }
    /* Google's own verdict on who really sent it: the first
       Authentication-Results header stamped by mx.google.com. A forged one
       written by the sender sits below it, or carries another authserv-id. */
    var authResults = "";
    (payload.headers || []).some(function (x) {
      if (!x || String(x.name || "").toLowerCase() !== "authentication-results") return false;
      var v = String(x.value == null ? "" : x.value);
      if (/^\s*mx\.google\.com\s*;/i.test(v)) { authResults = v.slice(0, 2048); return true; }
      return false;
    });
    return {
      id: j.id || "",
      threadId: j.threadId || "",
      from: h.from || "",
      authResults: authResults,
      subject: h.subject || "",
      date: date,
      text: acc.text.join("\n"),
      html: acc.html.join("\n"),
      snippet: j.snippet || ""
    };
  }

  /* the signed-in address, so the app can pass it back to Google as a
     login_hint and skip the account chooser next time */
  function getProfile(token, opts) {
    return getJson(token, API.replace(/\/messages$/, "/profile"), opts || {}).then(function (j) {
      var e = String((j && j.emailAddress) || "");
      return { email: /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/.test(e) ? e : "" };
    });
  }

  /* Disconnect: tell Google the token is finished -- through the same fetch
     captured at load, never one a later script could have wrapped */
  function revoke(token, opts) {
    var f = pickFetch(opts);
    if (!f || !token) return Promise.resolve(false);
    return f("https://oauth2.googleapis.com/revoke", {
      method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=" + encodeURIComponent(token)
    }).then(function (r) { return !!(r && r.ok); }, function () { return false; });
  }

  function getMessage(token, id, opts) {
    if (!id) return Promise.reject(err("http", "Message id is required", 0));
    var url = API + "/" + encodeURIComponent(id) + "?format=full";
    return getJson(token, url, opts || {}).then(toMessage);
  }

  function isKnown(known, id) {
    if (!known) return false;
    if (Array.isArray(known)) return known.indexOf(id) >= 0;
    return Object.prototype.hasOwnProperty.call(known, id) && !!known[id];
  }

  var PAGE_SIZE = 100;
  var MAX_PAGES = 10;

  /* Page through the listing newest-first, dropping known ids AS IT GOES, until
     max unknown ids are collected or the pages run out (hard stop: MAX_PAGES).
     Without this, once the newest max were known every check re-listed the
     same page and never reached older unknown mail. */
  function listUnknown(token, query, max, known, opts) {
    var ids = [], seen = {}, unknownSeen = 0, pages = 0;
    function page(pageToken) {
      pages++;
      var url = API + "?q=" + encodeURIComponent(query || "") + "&maxResults=" + PAGE_SIZE;
      if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
      return getJson(token, url, opts).then(function (j) {
        ((j && j.messages) || []).forEach(function (m) {
          var id = m && m.id;
          if (!id || seen[id]) return;
          seen[id] = 1;
          if (isKnown(known, id)) return;
          unknownSeen++;
          if (ids.length < max) ids.push(id);
        });
        var nextTok = j && j.nextPageToken && j.nextPageToken !== pageToken ? j.nextPageToken : null;
        if (nextTok && ids.length < max && pages < MAX_PAGES) return page(nextTok);
        return { ids: ids, listed: unknownSeen, more: unknownSeen > ids.length || !!nextTok };
      });
    }
    return page(null);
  }

  function fetchNew(token, opts) {
    opts = opts || {};
    var conc = Math.floor(Number(opts.concurrency));
    if (!(conc > 0)) conc = 4;
    if (conc > 10) conc = 10;
    var max = Math.floor(Number(opts.max));
    if (!(max > 0)) max = DEFAULT_MAX;
    if (max > HARD_MAX) max = HARD_MAX;
    var known = opts.knownIds;
    if (Array.isArray(known)) {
      var km = {};
      known.forEach(function (k) { km[k] = true; });
      known = km;
    }
    function decorate(arr, failed, scan) {
      arr.failed = failed;
      arr.listed = scan.listed;
      arr.more = scan.more;
      return arr;
    }
    return listUnknown(token, opts.query, max, known, { fetch: opts.fetch }).then(function (scan) {
      var todo = scan.ids;
      var results = new Array(todo.length);
      if (!todo.length) return decorate([], [], scan);
      return new Promise(function (resolve, reject) {
        var next = 0, active = 0, done = false, firstErr = null;
        var failedAt = {};
        function finish() {
          done = true;
          var failed = [], got = [];
          for (var i = 0; i < todo.length; i++) {
            if (failedAt[i]) failed.push(todo[i]);
            else if (results[i]) got.push(results[i]);
          }
          /* every download failed: that is an outage, not "nothing new" --
             reject so the caller does not advance its last-checked time */
          if (!got.length && failed.length) { reject(firstErr); return; }
          resolve(decorate(got, failed, scan));
        }
        function launch() {
          while (!done && active < conc && next < todo.length) {
            (function (idx) {
              active++;
              getMessage(token, todo[idx], { fetch: opts.fetch }).then(function (m) {
                results[idx] = m;
              }, function (e) {
                if (e && e.code === "auth") { if (!done) { done = true; reject(e); } return; }
                /* one bad message never sinks the batch, but it is reported */
                failedAt[idx] = true;
                if (!firstErr) firstErr = e && e.code ? e : err("network", (e && e.message) || "Download failed");
              }).then(function () {
                active--;
                if (done) return;
                if (next >= todo.length && active === 0) finish();
                else launch();
              });
            })(next++);
          }
        }
        launch();
      });
    });
  }

  var api = {
    SCOPE: SCOPE,
    authUrl: authUrl,
    newState: newState,
    readRedirect: readRedirect,
    buildQuery: buildQuery,
    listIds: listIds,
    getProfile: getProfile,
    revoke: revoke,
    getMessage: getMessage,
    fetchNew: fetchNew,
    /* internals, exposed for tests */
    _decodeBody: decodeBody,
    _utf8Decode: utf8Decode,
    _b64ToBytes: b64ToBytes
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    /* locked: no script that runs later can swap fetchNew for a copy that
       reads the token on its way through */
    Object.freeze(api);
    try { Object.defineProperty(root, "GmailSync", { value: api, writable: false, configurable: false, enumerable: true }); }
    catch (e) { root.GmailSync = api; }
  }
})(typeof window !== "undefined" ? window : this);
