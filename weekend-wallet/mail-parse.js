/* Mail parsing: turns one email (a receipt or a bank transaction alert) into
   a candidate transaction for the review inbox. Pure functions, no DOM, no
   network. Loaded by index.html as window.MailParse and testable in Node
   (module.exports guard at the bottom).

   Precision beats recall: the user confirms every candidate by hand, so a
   missed email costs one manual entry while a wrong amount costs trust. When
   unsure, this returns null. */
(function (root) {
  "use strict";

  /* ---------- known senders ---------- */

  /* Domains are matched exactly or as a parent domain (mail.glovoapp.com
     matches glovoapp.com). The CIH Bank domains are a BEST GUESS: no real CIH
     alert has been seen, so cihbank.ma / cih.co.ma may be incomplete or wrong.
     Bank alerts from any sender are also recognised by their wording, so a
     wrong domain here lowers confidence rather than dropping the alert. */
  var SENDERS = [
    { slug: "cih", domains: ["cihbank.ma", "cih.co.ma"], name: "CIH Bank", cat: "" },
    { slug: "glovo", domains: ["glovoapp.com"], name: "Glovo", cat: "food" },
    { slug: "jumia", domains: ["jumia.ma"], name: "Jumia", cat: "shop" },
    { slug: "careem", domains: ["careem.com"], name: "Careem", cat: "transport" },
    { slug: "yassir", domains: ["yassir.com"], name: "Yassir", cat: "transport" },
    { slug: "uber", domains: ["uber.com", "ubereats.com"], name: "Uber", cat: "transport" },
    { slug: "netflix", domains: ["netflix.com"], name: "Netflix", cat: "bills" },
    { slug: "spotify", domains: ["spotify.com"], name: "Spotify", cat: "bills" },
    { slug: "apple", domains: ["apple.com"], name: "Apple", cat: "bills" },
    { slug: "google", domains: ["google.com"], name: "Google Play", cat: "bills" },
    { slug: "amazon", domains: ["amazon.com", "amazon.fr", "amazon.de", "amazon.co.uk", "amazon.es", "amazon.it", "amazon.ae"], name: "Amazon", cat: "shop" },
    { slug: "inwi", domains: ["inwi.ma"], name: "inwi", cat: "bills" },
    { slug: "orange", domains: ["orange.ma"], name: "Orange", cat: "bills" },
    { slug: "iam", domains: ["iam.ma"], name: "Maroc Telecom", cat: "bills" }
  ];

  var KEYWORDS = [
    "paiement", "achat", "débit", "débité", "retrait", "virement", "crédité",
    "transaction", "reçu", "remboursement", "commande", "facture", "montant",
    "payment", "purchase", "receipt", "order", "invoice", "refund", "your trip"
  ];

  function str(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

  /* ---------- HTML to text ---------- */

  var NAMED = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
    eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
    agrave: "à", aacute: "á", acirc: "â", auml: "ä",
    ccedil: "ç", icirc: "î", iuml: "ï", iacute: "í",
    ocirc: "ô", ouml: "ö", oacute: "ó", ugrave: "ù",
    ucirc: "û", uuml: "ü", uacute: "ú", oelig: "œ",
    Eacute: "É", Egrave: "È", Ecirc: "Ê", Agrave: "À",
    Acirc: "Â", Ccedil: "Ç", Ocirc: "Ô", Icirc: "Î",
    euro: "€", pound: "£", laquo: "«", raquo: "»",
    rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
    hellip: "…", ndash: "–", mdash: "—", deg: "°",
    ordm: "º", copy: "©", reg: "®", trade: "™",
    middot: "·", bull: "•", times: "×", thinsp: " ",
    ensp: " ", emsp: " ", zwnj: "", zwj: "", shy: "", dollar: "$", percnt: "%"
  };

  function fromCode(n) {
    if (!isFinite(n) || n < 0 || n > 0x10ffff) return "";
    if (n === 160) return " ";
    if (n < 0x10000) return String.fromCharCode(n);
    n -= 0x10000;
    return String.fromCharCode(0xd800 + (n >> 10), 0xdc00 + (n & 0x3ff));
  }

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, function (all, e) {
      if (e.charAt(0) === "#") {
        return fromCode(e.charAt(1) === "x" || e.charAt(1) === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      }
      return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : all;
    });
  }

  var SPACE_RE = /[ \t\f\v  -   　]+/g;
  var ZW_RE = /[​-‍⁠﻿]/g;

  /* collapse spaces, tidy table pipes, trim lines, drop empty lines */
  function tidyLines(s) {
    var lines = s.replace(/\r\n?/g, "\n").replace(ZW_RE, "").split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(SPACE_RE, " ");
      l = l.replace(/(?:\s*\|\s*)+/g, " | ").replace(/^\s*\|\s*|\s*\|\s*$/g, "").trim();
      if (l) out.push(l);
    }
    return out.join("\n");
  }

  function htmlToText(html) {
    try {
      var s = str(html);
      if (!s) return "";
      if (s.length > 1000000) s = s.slice(0, 1000000);
      s = s.replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
        .replace(/<(style|script|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/[\r\n]+/g, " ")                                   /* source newlines are just whitespace */
        .replace(/<br\b[^>]*>/gi, "\n")
        .replace(/<\/(?:p|div|tr|li|h[1-6]|table|tbody|thead|ul|ol|section|article|header|footer|blockquote|center)\s*>/gi, "\n")
        .replace(/<(?:p|div|tr|li|h[1-6]|table)\b[^>]*>/gi, "\n")
        .replace(/<\/t[dh]\s*>/gi, " | ")
        .replace(/<[^>]*>/g, " ");
      return tidyLines(decodeEntities(s));
    } catch (e) {
      return "";
    }
  }

  /* ---------- amounts ---------- */

  /* "1 234,56" / "1.234,56" / "1,234.56" / "234.5" / "120" -> number.
     Adapted from scan.js parseAmountToken (minus the OCR letter-O repair). */
  function parseAmountToken(s) {
    s = str(s).replace(/\s/g, "").replace(/['’]/g, "");
    var lastDot = s.lastIndexOf("."), lastCom = s.lastIndexOf(",");
    if (lastDot > -1 && lastCom > -1) {
      if (lastCom > lastDot) {
        s = s.replace(/\./g, "");
        var c = s.lastIndexOf(",");
        s = s.slice(0, c).replace(/,/g, "") + "." + s.slice(c + 1);
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (lastCom > -1) {
      var dec = s.length - lastCom - 1;
      if (dec >= 1 && dec <= 2 && s.indexOf(",") === lastCom) s = s.slice(0, lastCom) + "." + s.slice(lastCom + 1);
      else s = s.replace(/,/g, "");
    } else if (lastDot > -1) {
      var dd = s.length - lastDot - 1;
      if (dd < 1 || dd > 2 || s.indexOf(".") !== lastDot) s = s.replace(/\./g, "");
    }
    return /^\d+(?:\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }

  var NUM = "\\d{1,3}(?:[ .,'\\u2019]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
  var CUR_PRE = "MAD|DHS?|EUR|USD|US\\$|€|\\$";
  var CUR_SUF = "MAD|DHS?|dirhams?|EUR|euros?|USD|€|\\$";
  var AMT_RE = new RegExp("(" + CUR_PRE + ")\\s?(-\\s?)?(" + NUM + ")|(-\\s?)?(" + NUM + ")\\s?(" + CUR_SUF + ")", "gi");
  var BARE_RE = new RegExp("(\\d{1,3}(?:[ .,]\\d{3})*[.,]\\d{2})(?![\\d%])", "g");
  var LETTER_RE = /[A-Za-zÀ-ÿ]/;
  /* a number right after these is a count or a reference, never money */
  var QTY_TAIL_RE = /(?:#|n[°o]\.?|\bref\w*|\border|\bcommande|\bx|qt[eé]|\bqty|quantit[eé]|\barticles?|\bitems?)\s*:?\s*$/i;

  function curCode(tok) {
    tok = tok.toLowerCase();
    if (tok === "€" || tok.indexOf("eur") === 0) return "EUR";
    if (tok === "$" || tok === "usd" || tok === "us$") return "USD";
    return "MAD";
  }

  /* Things that look like numbers but are not money: masked cards, dates,
     times, percentages, Moroccan phone numbers. Replaced by a "~" so the
     pieces on either side can never fuse into one fake thousands group. */
  var SCRUB = [
    /\d{4,6}[*xX•]{3,}\d{2,4}/g,                                    /* 457123XXXXXX1234 */
    /(?:[*xX•·]{2,}[\s-]?){1,4}\d{2,6}/g,                       /* ****1234, XXXX 1234 */
    /(?:termin\w*\s+par|finissant\s+par|ending\s+(?:in|with))\s*:?\s*\d{2,6}/gi,
    /\b(?:carte|card)\s*(?:n[°o]\.?|no\.?|#|num[eé]ro)?\s*:?\s*\d{4,}/gi,
    /\b\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}(?:T[\d:.]+Z?)?/g,                /* 2026-10-14 */
    /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g,                           /* 14/10/2026 */
    /\b\d{1,2}\/\d{1,2}\b/g,                                              /* 14/10 */
    /\b\d{1,2}(?:er)?\s+(?:janv|f[eé]vr|mars|avr|mai|juin|juil|ao[uû]t|sept|oct|nov|d[eé]c|jan|feb|mar|apr|may|jun|jul|aug|sep|dec)[a-zéû]*\.?\s+\d{4}/gi,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/gi,
    /\b\d{1,2}[:h]\d{2}(?::\d{2})?\b/gi,                                  /* 14:32, 14h32 */
    /\d+(?:[.,]\d+)?\s?%/g,
    /\+\d{3}[\s\d]{6,}\d/g,
    /\b0[5-8]\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}\b/g
  ];

  function scrub(line) {
    for (var i = 0; i < SCRUB.length; i++) line = line.replace(SCRUB[i], " ~ ");
    return line;
  }

  /* money tokens in one clause: [{n, cur, start, end, bare}] */
  function scanClause(clause) {
    var out = [], m;
    AMT_RE.lastIndex = 0;
    while ((m = AMT_RE.exec(clause)) !== null) {
      var start = m.index, end = start + m[0].length;
      var before = start > 0 ? clause.charAt(start - 1) : "";
      var after = clause.charAt(end);
      var raw, cur, ok = true;
      if (m[1]) {
        raw = m[3]; cur = m[1];
        if (/^[a-z]/i.test(cur) && before && LETTER_RE.test(before)) ok = false;   /* "NOMAD 5" */
        if (/[\d%]/.test(after)) ok = false;
      } else {
        raw = m[5]; cur = m[6];
        if (before && /[\d.,#\/A-Za-zÀ-ÿ]/.test(before)) ok = false;
        if (/^[a-z]/i.test(cur) && after && LETTER_RE.test(after)) ok = false;     /* "45 DHL" */
      }
      if (!ok) { AMT_RE.lastIndex = start + 1; continue; }
      /* "Qte 2 250,00 MAD": the space-grouped "2 250" is a count plus a price */
      if (/ /.test(raw) && QTY_TAIL_RE.test(clause.slice(Math.max(0, start - 20), start))) {
        raw = raw.slice(raw.lastIndexOf(" ") + 1);
      }
      var n = parseAmountToken(raw);
      if (isFinite(n) && n > 0 && n <= 1000000) out.push({ n: Math.round(n * 100) / 100, cur: curCode(cur), start: start, end: end, bare: false });
    }
    return out;
  }

  /* ---------- labels ---------- */

  var BAL_RE = /solde|balance|available|disponible|plafond|encours|\blimite?s?\b/i;
  var SUB_RE = /sous[\s-]*total|sub[\s-]*total|frais|\bfees?\b|\btips?\b|pourboire|discount|r[eé]duction|remise|\bpromo|coupon|voucher|\btaxe?s?\b|\btva\b|\bvat\b|\bh\.?t\.?(?![a-z])|livraison|delivery|commission|[eé]conomis|saved|cashback|\bpoints?\b|wallet|cr[eé]dits?\s+(?:glovo|careem|uber)/i;
  var TOTAL_RE = /\btotal\b|amount\s+charged|amount\s+paid|montant\s+(?:total|pay[eé]|d[eé]bit[eé]|factur[eé]|r[eé]gl[eé]|[aà]\s+payer)|you\s+paid|vous\s+avez\s+pay[eé]|net\s+[aà]\s+payer|charged|pay[eé]\s+(?:par|avec)|paid\s+(?:with|by)/i;
  var AMOUNT_RE = /montant|amount|somme|recharge/i;
  var DEBIT_RE = /d[eé]bit|paiement|payment|achat|purchase|retrait|withdrawal|virement\s+(?:[eé]mis|sortant|effectu)|transfer\s+sent|pr[eé]l[eè]vement|charged|pay[eé]|paid|transaction|op[eé]ration|spent|d[eé]pense/i;
  var CREDIT_RE = /cr[eé]dit[eé]|cr[eé]dit\s+de\s+(?=[\d~]|mad|dh)|virement\s+(?:re[cç]u|entrant|en\s+votre\s+faveur)|vous\s+avez\s+re[cç]u|you\s+(?:have\s+)?received|received\s+(?:a\s+)?(?:transfer|payment)|credited|incoming|versement|rembours|refund/i;
  var REFUND_RE = /rembours|refund|reversal|annulation|annul[eé]|avoir\s+de/i;
  var INCLUDED_RE = /\([^)]*(?:incl|compris)[^)]*\)|\b(?:tva|taxes?|vat|livraison|delivery|frais|fees?)\s+(?:incl\w*|compris\w*)|(?:incl\w*|including)\s+(?:tva|tax\w*|vat|fees?|delivery|livraison)|\bttc\b/gi;

  /* end position of the last match of re in s, or -1 */
  function lastEnd(re, s) {
    var g = new RegExp(re.source, "gi"), m, end = -1;
    while ((m = g.exec(s)) !== null) {
      end = m.index + m[0].length;
      if (!m[0].length) g.lastIndex++;
    }
    return end;
  }

  /* The label nearest the amount wins: in "Sous-total 70 | Total 85" each
     amount takes the word right before it. A balance word anywhere before
     it (since the previous amount) or right after it disqualifies it. */
  function labelOf(pre, post) {
    var tail = pre.slice(-80);
    if (BAL_RE.test(tail) || BAL_RE.test(post.slice(0, 30))) return "bal";
    tail = tail.replace(INCLUDED_RE, " ");
    var fams = [["sub", SUB_RE], ["total", TOTAL_RE], ["credit", CREDIT_RE], ["debit", DEBIT_RE], ["amount", AMOUNT_RE]];
    var best = "", bestEnd = -1;
    for (var i = 0; i < fams.length; i++) {
      var e = lastEnd(fams[i][1], tail);
      if (e > bestEnd) { bestEnd = e; best = fams[i][0]; }   /* strict ">" keeps the earlier family on ties */
    }
    return best;
  }

  function verbOf(pre) {
    var d = lastEnd(DEBIT_RE, pre), c = lastEnd(CREDIT_RE, pre);
    if (d < 0 && c < 0) return "";
    return c >= d ? "credit" : "debit";
  }

  /* split a line into sentences; a decimal point is never followed by a space */
  function clausesOf(line) {
    return line.split(/[.;!?](?:\s+|$)/);
  }

  function collect(lines) {
    var cands = [], prevNoAmt = "";
    for (var i = 0; i < lines.length; i++) {
      var clauses = clausesOf(scrub(lines[i]));
      var lineHits = 0;
      for (var ci = 0; ci < clauses.length; ci++) {
        var clause = clauses[ci];
        var hits = scanClause(clause);
        /* "Total : 85,00" with no currency on the line: only on a labelled
           line, only with cents, and the currency is inferred later */
        var labelled = TOTAL_RE.test(clause) || AMOUNT_RE.test(clause) ||
          (ci === 0 && (TOTAL_RE.test(prevNoAmt) || AMOUNT_RE.test(prevNoAmt)));
        if (!hits.length && labelled && !BAL_RE.test(clause)) {
          var bm;
          BARE_RE.lastIndex = 0;
          while ((bm = BARE_RE.exec(clause)) !== null) {
            var b4 = bm.index > 0 ? clause.charAt(bm.index - 1) : "";
            if (b4 && /[\d.,#\/A-Za-z]/.test(b4)) continue;
            if (QTY_TAIL_RE.test(clause.slice(Math.max(0, bm.index - 20), bm.index))) continue;
            var bn = parseAmountToken(bm[1]);
            if (isFinite(bn) && bn > 0 && bn <= 1000000) {
              hits.push({ n: Math.round(bn * 100) / 100, cur: "", start: bm.index, end: bm.index + bm[0].length, bare: true });
              break;
            }
          }
        }
        var prevEnd = 0;
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          var pre = clause.slice(prevEnd, hit.start);
          /* label in one cell/line, amount alone on the next */
          if (h === 0 && ci === 0 && !LETTER_RE.test(pre) && prevNoAmt) pre = prevNoAmt + " " + pre;
          var post = clause.slice(hit.end, h + 1 < hits.length ? hits[h + 1].start : clause.length);
          hit.label = labelOf(pre, post);
          hit.verb = hit.label === "bal" ? "" : verbOf(pre);
          hit.clause = clause;
          hit.line = i;
          cands.push(hit);
          prevEnd = hit.end;
        }
        lineHits += hits.length;
      }
      prevNoAmt = lineHits ? "" : (lines[i].length <= 60 ? scrub(lines[i]) : "");
    }
    return cands;
  }

  /* ---------- dates ---------- */

  var MONTHS = {
    jan: 1, janv: 1, janvier: 1, january: 1, feb: 2, fev: 2, fevr: 2, fevrier: 2, february: 2,
    mar: 3, mars: 3, march: 3, apr: 4, avr: 4, avril: 4, april: 4, may: 5, mai: 5,
    jun: 6, juin: 6, june: 6, jul: 7, juil: 7, juillet: 7, july: 7, aug: 8, aou: 8, aout: 8, august: 8,
    sep: 9, sept: 9, septembre: 9, september: 9, oct: 10, octobre: 10, october: 10,
    nov: 11, novembre: 11, november: 11, dec: 12, decembre: 12, december: 12
  };

  function monthNum(word) {
    var w = word.toLowerCase().replace(/\./g, "").replace(/[éè]/g, "e").replace(/û/g, "u");
    if (MONTHS[w]) return MONTHS[w];
    if (w.length >= 3 && MONTHS[w.slice(0, 4)]) return MONTHS[w.slice(0, 4)];
    return MONTHS[w.slice(0, 3)] || 0;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  function mailDate(s) {
    s = str(s).trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function validDate(y, mo, da, ref) {
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || y < 2015 || y > 2100) return null;
    var d = new Date(y, mo - 1, da, 12);
    if (d.getDate() !== da) return null;
    if (ref) {
      var age = (ref.getTime() - d.getTime()) / 86400000;
      if (age < -1.5 || age > 45) return null;   /* a transaction is just before its email */
    }
    return d;
  }

  function bodyDate(text, ref) {
    var res = [
      [/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/g, function (m) { return validDate(+m[1], +m[2], +m[3], ref); }],
      [/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g, function (m) {
        var a = +m[1], b = +m[2];
        return a <= 12 && b > 12 ? validDate(+m[3], a, b, ref) : validDate(+m[3], b, a, ref);
      }],
      [/\b(\d{1,2})(?:er)?\s+([A-Za-zéû]{3,9}\.?)\s+(\d{4})\b/g, function (m) {
        var mo = monthNum(m[2]); return mo ? validDate(+m[3], mo, +m[1], ref) : null;
      }],
      [/\b([A-Za-z]{3,9}\.?)\s+(\d{1,2}),?\s+(\d{4})\b/g, function (m) {
        var mo = monthNum(m[1]); return mo ? validDate(+m[3], mo, +m[2], ref) : null;
      }]
    ];
    var found = [];
    for (var i = 0; i < res.length; i++) {
      var re = res[i][0], m;
      while ((m = re.exec(text)) !== null) {
        var d = res[i][1](m);
        if (d) found.push({ at: m.index, d: d });
      }
    }
    found.sort(function (a, b) { return a.at - b.at; });
    return found.length ? found[0].d : null;
  }

  /* ---------- sender, merchant, category ---------- */

  function parseFrom(from) {
    from = str(from).trim();
    var email = "", name = "";
    var m = /^(.*?)<\s*([^>\s]+@[^>\s]+)\s*>/.exec(from);
    if (m) { name = m[1]; email = m[2]; }
    else {
      var e = /[^\s<>"]+@[^\s<>"]+/.exec(from);
      if (e) email = e[0];
      else name = from;
    }
    name = name.replace(/["']/g, "").replace(/\s+via\s+.*$/i, "").replace(/\s+/g, " ").trim();
    if (/@/.test(name)) name = "";
    var domain = (email.split("@")[1] || "").toLowerCase().replace(/[^a-z0-9.\-]/g, "");
    if (!name && domain) {
      var parts = domain.split(".");
      var core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      if (/^(?:co|com|net|org)$/.test(core) && parts.length >= 3) core = parts[parts.length - 3];
      name = core ? core.charAt(0).toUpperCase() + core.slice(1) : "";
    }
    return { name: name.slice(0, 40), email: email.toLowerCase(), domain: domain };
  }

  function matchSender(domain) {
    if (!domain) return null;
    var amazon = /(?:^|\.)amazon\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(domain);
    for (var i = 0; i < SENDERS.length; i++) {
      if (amazon && SENDERS[i].slug === "amazon") return SENDERS[i];
      var ds = SENDERS[i].domains;
      for (var j = 0; j < ds.length; j++) {
        var d = ds[j];
        if (domain === d || domain.slice(-(d.length + 1)) === "." + d) return SENDERS[i];
      }
    }
    return null;
  }

  function prettify(name) {
    name = name.replace(/\s+/g, " ").trim();
    if (/[a-zà-ÿ]/.test(name)) return name.slice(0, 40).trim();
    var words = name.split(" ");
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (i > 0 && /^(?:DE|DU|DES|LA|LE|LES|ET)$/.test(w)) words[i] = w.toLowerCase();
      else if (w.length > 3 && /^[A-ZÀ-Þ]/.test(w)) words[i] = w.charAt(0) + w.slice(1).toLowerCase();
    }
    return words.join(" ").slice(0, 40).trim();
  }

  var MERCH_LABEL_RE = /(^|[^A-Za-zÀ-ÿ])(chez|aupr[eè]s\s+d(?:e\s|u\s|')|marchand\s*:|commer[cç]ant\s*:|merchant(?:\s+name)?\s*:|b[eé]n[eé]ficiaire\s*:|payee\s*:|de\s+la\s+part\s+de|[eé]metteur\s*:|donneur\s+d'ordre\s*:)\s*/gi;
  var MERCH_AT_RE = /\s(?:at|@)\s+(?=[A-Z0-9])/g;
  var MERCH_STOP_RE = /\s+(?:le|on|du|pour|for|avec|with|via|par|by|d'un|d'une|dated|using|en\s+date|ce|this|au|aux|à|a|is|est|was|a\s+[eé]t[eé])(?=\s|$)[\s\S]*$/i;
  var MERCH_BAD_RE = /^(?:vous|votre|vos|nous|notre|your|you|the|un|une|le|la|les|ce|cette|this|our|carte|card|compte|account)(?![A-Za-zÀ-ÿ])/i;

  function cleanMerchant(rest) {
    var v = rest.split(/[\n|;~()]|,\s|\.\s|\.$|\s[-–—]\s/)[0];
    v = v.replace(MERCH_STOP_RE, "");
    v = v.replace(/\s+-?\d[\d\s.,]*(?:mad|dhs?|eur|usd|€|\$)?[\s\S]*$/i, "");
    v = v.replace(/\s+(?:mad|dhs?|eur|usd)(?![A-Za-z])[\s\S]*$/i, "");
    v = v.replace(/^[\s:"'«]+|[\s.,:;"'»]+$/g, "");
    if ((v.match(/[A-Za-zÀ-ÿ]/g) || []).length < 2 || MERCH_BAD_RE.test(v)) return "";
    return prettify(v);
  }

  function extractMerchant(lines, preferLine) {
    var order = [preferLine];
    for (var i = 0; i < lines.length; i++) if (i !== preferLine) order.push(i);
    for (var k = 0; k < order.length; k++) {
      var line = lines[order[k]];
      if (line == null) continue;
      line = scrub(line);
      var m, v;
      MERCH_LABEL_RE.lastIndex = 0;
      while ((m = MERCH_LABEL_RE.exec(line)) !== null) {
        v = cleanMerchant(line.slice(m.index + m[0].length));
        if (v) return v;
      }
      MERCH_AT_RE.lastIndex = 0;
      while ((m = MERCH_AT_RE.exec(line)) !== null) {
        v = cleanMerchant(line.slice(m.index + m[0].length));
        if (v) return v;
      }
    }
    return "";
  }

  /* small brand/keyword map for merchant names seen on bank alerts */
  var CAT_RULES = [
    ["food", /marjane|carrefour|acima|aswak|\bbim\b|label.?vie|glovo|mcdo|mcdonald|\bkfc\b|burger|pizza|domino|restaurant|\bresto\b|caf[eé]|coffee|snack|boulangerie|p[aâ]tisserie|tacos|sushi|food|hanout|[eé]picerie|supermarch/i],
    ["drinks", /\bbar\b|\bpub\b|lounge/i],
    ["transport", /afriquia|totalenergies|shell|petromin|winxo|ziz\b|oncf|\bctm\b|uber|careem|yassir|indrive|taxi|parking|autoroute|p[eé]age|station|carburant/i],
    ["shop", /zara|bershka|pull.?bear|kiabi|decathlon|jumia|amazon|aliexpress|lc\s*waikiki|h&m|defacto|electroplanet|virgin|\bstore\b|boutique/i],
    ["health", /pharmac|clinique|clinic|dentist|docteur|laboratoire|hopital|h[oô]pital/i],
    ["bills", /inwi|orange|maroc\s*telecom|\biam\b|lydec|redal|amendis|onee|radeema|netflix|spotify|apple\.com|itunes|google\s*play|icloud|youtube|disney|shahid|facture/i],
    ["out", /megarama|cin[eé]ma|imax|bowling|padel|billet|concert|playstation|steam/i],
    ["travel", /h[oô]tel|airbnb|booking\.com|royal\s*air\s*maroc|\bram\b|ryanair|air\s*arabia|easyjet|transavia|riad/i],
    ["personal", /coiffeur|barber|salon|beaut|parfum|yves\s*rocher|sephora/i],
    ["education", /[eé]cole|school|universit|udemy|coursera|librairie|formation/i],
    ["home", /ikea|kitea|mr\s*bricolage|bricoma|meuble|maison/i]
  ];

  function guessCat(s) {
    s = str(s);
    for (var i = 0; i < CAT_RULES.length; i++) if (CAT_RULES[i][1].test(s)) return CAT_RULES[i][0];
    return "";
  }

  /* ---------- filters ---------- */

  var OTP_RE = /code\s+(?:de\s+)?(?:v[eé]rification|confirmation|s[eé]curit[eé]|d'activation|otp|3d\s*secure)|verification\s+code|security\s+code|\botp\b|one[\s-]?time\s+(?:password|code|passcode|pin)|code\s+[aà]\s+usage\s+unique|mot\s+de\s+passe\s+(?:unique|temporaire)|3d\s*secure/i;
  var SECURITY_SUBJ_RE = /mot\s+de\s+passe|password|passcode|sign[\s-]?in|log[\s-]?in|connexion|nouvel\s+appareil|new\s+device|identifiants?|verify\s+your|v[eé]rifiez\s+votre\s+(?:adresse|email|e-mail|identit)/i;
  var STATEMENT_SUBJ_RE = /relev[eé]|statement|extrait\s+de\s+compte/i;
  var PROMO_RE = /promo|\boffre|\boffer|%\s?off|-\s?\d+\s?%|\d+\s?%\s+(?:de\s+)?(?:r[eé]duction|off|discount)|newsletter|unsubscribe|d[eé]sabonn|d[eé]sinscri|profitez|bon\s+plan|\bdeals?\b|black\s+friday|[eé]conomisez|\bsave\s+(?:up|\d)|gratuit|free\s+delivery|nouveaut[eé]s/i;
  var FAILED_RE = /[eé]chec|[eé]chou[eé]|failed|declined|refus[eé]|unsuccessful|n'a\s+pas\s+(?:pu\s+)?(?:[eé]t[eé]\s+)?(?:effectu|accept|trait|abouti)|could\s+not\s+be\s+(?:processed|charged|completed)|insufficient|insuffisant|update\s+your\s+payment|mettre\s+[aà]\s+jour\s+votre\s+(?:moyen|mode)\s+de\s+paiement/i;
  var RECEIPT_RE = /re[cç]u(?![a-z])|receipt|facture|invoice|\bcommande\b|\border\b|achat|purchase|paiement|payment|merci\s+pour\s+votre|thank\s+you\s+for\s+your|thanks\s+for\s+(?:riding|your)|your\s+trip|votre\s+course|confirmation|abonnement|subscription|recharge/i;
  var BANK_CTX_RE = /carte|card|compte|account|virement|transfer|retrait|withdrawal|\bdab\b|\bgab\b|\batm\b/i;
  var CASH_RE = /retrait|withdrawal|\bdab\b|\bgab\b|\batm\b/i;

  /* ---------- assemble ---------- */

  function finish(c, o, cands) {
    var cur = c.cur;
    if (!cur) {   /* bare "Total : 85,00": borrow the mail's own currency */
      for (var i = 0; i < cands.length; i++) if (cands[i].cur) { cur = cands[i].cur; break; }
      cur = cur || "MAD";
      o.confidence -= 0.1;
      o.reason += " (no currency on the line, assumed " + cur + ")";
    }
    var merchant = str(o.merchant).replace(/\s+/g, " ").trim().slice(0, 40).trim() || "Unknown";
    return {
      amount: c.n,
      currency: cur,
      kind: o.kind,
      merchant: merchant,
      date: o.date,
      cat: o.cat || "",
      source: o.source,
      confidence: Math.max(0, Math.min(1, Math.round(o.confidence * 100) / 100)),
      reason: o.reason
    };
  }

  function lastOf(cands, label) {
    var hit = null;
    for (var i = 0; i < cands.length; i++) if (cands[i].label === label) hit = cands[i];
    return hit;
  }

  function parseReceipt(known, sender, subject, all, cands, base) {
    var c = lastOf(cands, "total"), conf = 0.9, why = "total line";
    if (!c) { c = lastOf(cands, "amount"); conf = 0.8; why = "amount line"; }
    if (!c) {
      /* no label at all: only a mail that names one single sum is trusted */
      var vals = {}, n = 0, only = null;
      for (var i = 0; i < cands.length; i++) {
        var k = cands[i];
        if (k.bare || k.label === "bal" || k.label === "sub") continue;
        if (!vals[k.n + k.cur]) { vals[k.n + k.cur] = 1; n++; only = k; }
      }
      if (n === 1 && RECEIPT_RE.test(all)) { c = only; conf = 0.55; why = "single amount in mail"; }
    }
    if (!c || FAILED_RE.test(c.clause)) return null;
    var merchant = known.name, cat = known.cat;
    if (known.slug === "uber" && /uber\s*eats|ubereats/i.test(all + " " + sender.domain)) { merchant = "Uber Eats"; cat = "food"; }
    base.merchant = merchant;
    base.cat = cat;
    base.source = known.slug;
    base.kind = REFUND_RE.test(subject + " " + c.clause) ? "refund" : "debit";
    base.confidence = conf;
    base.reason = merchant + " receipt: " + why;
    return finish(c, base, cands);
  }

  function parseBank(isCih, sender, subject, lines, all, cands, base) {
    var c = null, conf = 0;
    for (var i = 0; i < cands.length; i++) {
      var k = cands[i];
      if (k.label === "bal" || k.label === "sub") continue;
      if (k.verb) { c = k; conf = isCih ? 0.85 : 0.75; break; }
    }
    var globalVerb = verbOf(all);
    if (!c && isCih && globalVerb) {
      for (var j = 0; j < cands.length; j++) {
        if (cands[j].label === "amount" || cands[j].label === "total") { c = cands[j]; conf = 0.75; break; }
      }
    }
    if (!c || FAILED_RE.test(c.clause) || FAILED_RE.test(lines[c.line] || "")) return null;
    var verb = c.verb || globalVerb;
    var ctx = subject + " " + c.clause;
    var kind = verb === "credit" ? "credit" : "debit";
    if (REFUND_RE.test(ctx)) kind = "refund";
    var merchant, cat = "";
    if (kind === "debit" && CASH_RE.test(ctx)) {
      merchant = "Cash withdrawal";
    } else {
      merchant = extractMerchant(lines, c.line);
      if (kind === "debit") cat = guessCat(merchant);
      if (!merchant) merchant = isCih ? "CIH Bank" : (sender.name || "Bank");
    }
    base.merchant = merchant;
    base.cat = cat;
    base.kind = kind;
    base.source = isCih ? "cih" : "generic";
    base.confidence = conf;
    base.reason = (isCih ? "CIH alert" : "bank-style alert") + ": " +
      (c.verb ? c.verb + " wording + amount in the same sentence" : "amount line, " + globalVerb + " wording elsewhere");
    return finish(c, base, cands);
  }

  function parseGeneric(sender, subject, all, cands, base) {
    if (!RECEIPT_RE.test(all)) return null;
    var c = lastOf(cands, "total");
    if (!c || FAILED_RE.test(c.clause)) return null;
    base.merchant = sender.name || "Unknown";
    base.cat = guessCat(sender.name + " " + subject);
    base.kind = REFUND_RE.test(subject + " " + c.clause) ? "refund" : "debit";
    base.source = "generic";
    base.confidence = 0.6;
    base.reason = "receipt wording + total line from an unknown sender";
    return finish(c, base, cands);
  }

  function parseMailInner(mail) {
    if (!mail || typeof mail !== "object") return null;
    var subject = str(mail.subject).replace(SPACE_RE, " ").trim().slice(0, 500);
    var text = str(mail.text), html = str(mail.html);
    if (text.replace(/\s/g, "").length < 20 && html) text = htmlToText(html);
    else if (/^\s*<(?:!doctype|html|body|div|table|p)\b/i.test(text)) text = htmlToText(text);
    else text = tidyLines(text.length > 1000000 ? text.slice(0, 1000000) : text);
    if (text.length > 200000) text = text.slice(0, 200000);
    var body = text.split("\n");
    if (!subject && !text) return null;
    var lines = subject ? [subject].concat(body) : body;
    var all = lines.join("\n");

    var sender = parseFrom(mail.from);
    var known = matchSender(sender.domain);
    if (known && known.slug === "google" && !/google\s*play/i.test(all)) known = null;

    if (STATEMENT_SUBJ_RE.test(subject) || SECURITY_SUBJ_RE.test(subject) || OTP_RE.test(all)) return null;

    var cands = collect(lines);
    if (!cands.length) return null;

    var ref = mailDate(mail.date);
    var bd = bodyDate(all, ref);
    var base = { date: ymd(bd || ref || new Date()) };

    var hasTotal = !!lastOf(cands, "total") && RECEIPT_RE.test(all);
    var hasVerbAmt = false;
    for (var i = 0; i < cands.length; i++) if (cands[i].verb && cands[i].label !== "bal" && cands[i].label !== "sub") hasVerbAmt = true;
    var bankish = hasVerbAmt && BANK_CTX_RE.test(all);
    if (PROMO_RE.test(all) && !hasTotal && !bankish) return null;

    if (known && known.slug === "cih") return parseBank(true, sender, subject, lines, all, cands, base);
    if (known) return parseReceipt(known, sender, subject, all, cands, base);
    if (bankish) {
      var b = parseBank(false, sender, subject, lines, all, cands, base);
      if (b) return b;
      base = { date: base.date };
    }
    return parseGeneric(sender, subject, all, cands, base);
  }

  function parseMail(mail) {
    try {
      return parseMailInner(mail);
    } catch (e) {
      return null;
    }
  }

  var api = { htmlToText: htmlToText, parseMail: parseMail, SENDERS: SENDERS, KEYWORDS: KEYWORDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MailParse = api;
})(typeof window !== "undefined" ? window : this);
