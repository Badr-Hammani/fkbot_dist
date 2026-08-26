/* Receipt parsing — pure functions, no browser needed.
   These are the cheapest tests in the suite and cover the bug that shipped
   undetected for weeks: European amounts parsed at 1/100th of their value. */
"use strict";
const { scanLib } = require("../harness");

exports.name = "scan · receipt parsing";
exports.run = async function (t) {
  const P = scanLib();
  const { parseAmountToken, parseReceiptText, guessCategory } = P;
  const NOW = new Date("2026-08-18T09:00:00");

  /* --- amount tokens, both separator conventions --- */
  const amounts = [
    ["1.234,56", 1234.56, "dot thousands, comma decimal (FR/MA)"],
    ["1.000,00", 1000, "dot thousands, zero cents"],
    ["12.345,00", 12345, "five figures"],
    ["1.234.567,89", 1234567.89, "millions"],
    ["1,234.56", 1234.56, "comma thousands, dot decimal (US)"],
    ["1 234,56", 1234.56, "space thousands"],
    ["99,99", 99.99, "bare comma decimal"],
    ["234.5", 234.5, "one decimal place"],
    ["120", 120, "integer"],
    ["0,50", 0.5, "sub-unit"]
  ];
  for (const [raw, want, why] of amounts) t.near('parseAmountToken("' + raw + '") — ' + why, parseAmountToken(raw), want);

  /* --- whole receipts --- */
  const moroccan = parseReceiptText(
    "CARREFOUR MARKET\nSOUS-TOTAL 1.100,00\nTVA 134,56\nNET A PAYER 1.234,56\n12/08/2026", NOW);
  t.near("Moroccan receipt total (not the day of the date)", moroccan.amount, 1234.56);
  t.eq("Moroccan receipt merchant", moroccan.merchant, "CARREFOUR MARKET");
  t.eq("Moroccan receipt date, day-first", moroccan.date, "2026-08-12");

  const iso = parseReceiptText("SNACK ATLAS\nTOTAL 87,50\n2026-08-12", NOW);
  t.near("ISO-dated receipt total", iso.amount, 87.5);
  t.eq("ISO date parsed", iso.date, "2026-08-12");

  const usStyle = parseReceiptText("COFFEE HOUSE\nSubtotal 4.50\nTax 0.45\nTotal 4.95\n08/12/2026", NOW);
  t.near("total beats subtotal", usStyle.amount, 4.95);

  /* --- date sanity: a miss returns null, never a wrong guess --- */
  t.ok("nonsense date rejected", parseReceiptText("SHOP\nTOTAL 10\n45/45/2026", NOW).date === null);
  t.ok("far-past date rejected", parseReceiptText("SHOP\nTOTAL 10\n01/01/2011", NOW).date === null);
  /* 08/12/2026 is day-first = 8 December, which is in the future, so it is
     dropped rather than silently read as the American 12 August */
  t.ok("ambiguous future date dropped, not guessed", usStyle.date === null);

  /* --- categories, including the local vocabulary --- */
  const cats = [["kahwa", "food"], ["tajine", "food"], ["marjane", "food"], ["afriquia", "transport"],
                ["taxi", "transport"], ["padel", "out"], ["zara", "shop"], ["chicha", "drinks"]];
  for (const [word, want] of cats) t.eq('guessCategory("' + word + '")', guessCategory(word), want);
  t.ok("unknown text has no category", guessCategory("qqqq zzz") === null);

  /* --- garbage in --- */
  t.ok("empty text doesn't throw", (() => { try { parseReceiptText("", NOW); return true; } catch (e) { return false; } })());
  t.ok("null text doesn't throw", (() => { try { parseReceiptText(null, NOW); return true; } catch (e) { return false; } })());
  t.ok("huge number rejected as an amount", !(parseAmountToken("999999999999") <= 200000));
};
