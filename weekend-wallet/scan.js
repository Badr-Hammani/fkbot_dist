/* Receipt text parsing — pure functions, no DOM. Loaded by index.html and
   testable in Node (module.exports guard at the bottom). */
(function (root) {
  "use strict";

  /* "1 234,56" / "1,234.56" / "234.5" / "120" → number (or NaN) */
  function parseAmountToken(s) {
    s = String(s).replace(/\s/g, "");
    var lastDot = s.lastIndexOf(".");
    var lastCom = s.lastIndexOf(",");
    if (lastDot > -1 && lastCom > -1) {
      if (lastCom > lastDot) {
        s = s.replace(/\./g, "").replace(/,/g, function (m, i) { return i === s.lastIndexOf(",") ? "." : ""; });
        // simpler: remove dots, convert final comma
        s = s.split(",");
        s = s.slice(0, -1).join("") + "." + s[s.length - 1];
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (lastCom > -1) {
      var decimals = s.length - lastCom - 1;
      if (decimals >= 1 && decimals <= 2 && s.indexOf(",") === lastCom) {
        s = s.slice(0, lastCom) + "." + s.slice(lastCom + 1);
      } else {
        s = s.replace(/,/g, "");
      }
    }
    return parseFloat(s);
  }

  var NUM_RE = /\d{1,3}(?:[ .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

  function numbersIn(line) {
    var out = [];
    var m, raw;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(line)) !== null) {
      raw = m[0];
      var digits = raw.replace(/\D/g, "");
      if (digits.length > 7) continue;               // phone numbers, barcodes
      if (/^(19|20)\d{2}$/.test(raw)) continue;      // bare years
      var n = parseAmountToken(raw);
      if (isFinite(n) && n >= 0.2 && n <= 200000) out.push(n);
    }
    return out;
  }

  var TOTAL_RE = /grand\s*total|total\s*ttc|net\s*[aà]\s*payer|[aà]\s*payer|montant\s*(?:total|d[uû])?|amount\s*due|balance\s*due|\btotal\b|\bsomme\b/i;
  var NOT_TOTAL_RE = /sub\s*-?\s*total|sous\s*-?\s*total|\btva\b|\btax\b|\bh\.?t\.?\b|remise|discount|change|rendu|cash|esp[eè]ces/i;

  function guessAmount(lines) {
    var best = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!TOTAL_RE.test(line) || NOT_TOTAL_RE.test(line)) continue;
      var nums = numbersIn(line);
      if (!nums.length && i + 1 < lines.length) nums = numbersIn(lines[i + 1]);
      if (nums.length) {
        var candidate = Math.max.apply(null, nums);
        if (best === null || candidate > best) best = candidate;
      }
    }
    if (best !== null) return best;
    // fallback: largest plausible number anywhere
    var all = [];
    for (var j = 0; j < lines.length; j++) all = all.concat(numbersIn(lines[j]));
    return all.length ? Math.max.apply(null, all) : null;
  }

  function guessMerchant(lines) {
    for (var i = 0; i < Math.min(lines.length, 5); i++) {
      var line = lines[i];
      var letters = (line.match(/[A-Za-zÀ-ÿ]/g) || []).length;
      if (letters < 3 || line.length > 42) continue;
      if (/facture|receipt|ticket|invoice|caisse|bienvenue|welcome|tel[.:\s]|www\.|https?:|n[°o]\s*\d/i.test(line)) continue;
      return line.replace(/\s{2,}/g, " ").trim();
    }
    return null;
  }

  /* dd/mm/yyyy (also dd-mm-yy, dd.mm.yyyy) → ISO, day-first preference */
  function guessDate(text, now) {
    now = now || new Date();
    var m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(text);
    if (!m) return null;
    var a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    var day = a, month = b;
    if (a <= 12 && b > 12) { day = b; month = a; }   // clearly mm/dd
    if (month < 1 || month > 12 || day < 1 || day > 31 || y < 2015 || y > now.getFullYear() + 1) return null;
    var d = new Date(y, month - 1, day);
    if (d.getDate() !== day) return null;
    var ageDays = (now - d) / 86400000;
    if (ageDays < -2 || ageDays > 400) return null;
    return y + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }

  var CATEGORY_RULES = [
    { cat: "food", re: /caf[eé]|coffee|restaurant|resto|pizz|burger|tacos|snack|grill|food|boulangerie|patisserie|p[aâ]tisserie|marjane|carrefour|acima|aswak|\bbim\b|market|supermarch/i },
    { cat: "drinks", re: /\bbar\b|\bpub\b|lounge|brasserie|juice|jus\b/i },
    { cat: "out", re: /cin[eé]ma|megarama|bowling|karting|club|billetterie|concert|spa\b|hammam/i },
    { cat: "transport", re: /taxi|uber|careem|indrive|oncf|\bctm\b|tramway|\bbus\b|parking|autoroute|p[eé]age|afriquia|winxo|petromin|station|essence|gasoil|car\s*wash/i },
    { cat: "shop", re: /zara|bershka|pull\s*&?\s*bear|kiabi|decathlon|electro|pharmacie|pharmacy|parfumerie|boutique|store|shop/i }
  ];

  function guessCategory(text) {
    for (var i = 0; i < CATEGORY_RULES.length; i++) {
      if (CATEGORY_RULES[i].re.test(text)) return CATEGORY_RULES[i].cat;
    }
    return null;
  }

  function parseReceiptText(text, now) {
    var lines = String(text || "").split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    return {
      amount: guessAmount(lines),
      merchant: guessMerchant(lines),
      date: guessDate(lines.join("\n"), now),
      category: guessCategory(text || "")
    };
  }

  var api = { parseReceiptText: parseReceiptText, parseAmountToken: parseAmountToken };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptParse = api;
})(typeof window !== "undefined" ? window : this);
