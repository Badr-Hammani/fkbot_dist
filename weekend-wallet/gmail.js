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

  function pickFetch(opts) {
    var f = opts && opts.fetch;
    if (typeof f === "function") return f;
    if (root && typeof root.fetch === "function") return root.fetch;
    if (typeof fetch === "function") return fetch;
    return null;
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
      ["include_granted_scopes", "true"],
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
    return {
      id: j.id || "",
      threadId: j.threadId || "",
      from: h.from || "",
      subject: h.subject || "",
      date: date,
      text: acc.text.join("\n"),
      html: acc.html.join("\n"),
      snippet: j.snippet || ""
    };
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

  function fetchNew(token, opts) {
    opts = opts || {};
    var conc = Math.floor(Number(opts.concurrency));
    if (!(conc > 0)) conc = 4;
    if (conc > 10) conc = 10;
    var known = opts.knownIds;
    if (Array.isArray(known)) {
      var km = {};
      known.forEach(function (k) { km[k] = true; });
      known = km;
    }
    return listIds(token, opts.query, { max: opts.max, fetch: opts.fetch }).then(function (ids) {
      var todo = ids.filter(function (id) { return !isKnown(known, id); });
      var results = new Array(todo.length);
      if (!todo.length) return [];
      return new Promise(function (resolve, reject) {
        var next = 0, active = 0, done = false;
        function finish() {
          done = true;
          resolve(results.filter(function (m) { return !!m; }));
        }
        function launch() {
          while (!done && active < conc && next < todo.length) {
            (function (idx) {
              active++;
              getMessage(token, todo[idx], { fetch: opts.fetch }).then(function (m) {
                results[idx] = m;
              }, function (e) {
                if (e && e.code === "auth") { if (!done) { done = true; reject(e); } return; }
                results[idx] = null; /* one bad message never sinks the batch */
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
    getMessage: getMessage,
    fetchNew: fetchNew,
    /* internals, exposed for tests */
    _decodeBody: decodeBody,
    _utf8Decode: utf8Decode,
    _b64ToBytes: b64ToBytes
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GmailSync = api;
})(typeof window !== "undefined" ? window : this);
