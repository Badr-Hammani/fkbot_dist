/* Mail parsing — pure functions, no browser needed.
   ALL sample emails below are synthetic: constructed to match common phrasing,
   not copies of real CIH templates (or of any real merchant's receipts). No
   real CIH alert has been seen, so these guard the generic French/English
   bank-alert wording the parser relies on, not one exact template.
   Precision matters more than recall here: every case that must NOT become a
   transaction is as important as the ones that must. */
"use strict";
const path = require("path");
const { APP_DIR } = require("../harness");

exports.name = "mailparse · email receipts and bank alerts";
exports.run = async function (t) {
  delete require.cache[require.resolve(path.join(APP_DIR, "mail-parse.js"))];
  const M = require(path.join(APP_DIR, "mail-parse.js"));
  const { parseMail, htmlToText, SENDERS, KEYWORDS } = M;
  const mail = (o) => Object.assign({ id: "m1", from: "", subject: "", date: "2026-10-14T12:00:00+01:00", text: "", html: "" }, o);
  const field = (r, k) => (r ? r[k] : "(null)");

  /* --- API shape --- */
  t.ok("exports htmlToText/parseMail/SENDERS/KEYWORDS",
    typeof htmlToText === "function" && typeof parseMail === "function" && Array.isArray(SENDERS) && Array.isArray(KEYWORDS));
  t.ok("SENDERS carry slug, domains, name, cat",
    SENDERS.every(s => s.slug && Array.isArray(s.domains) && s.domains.length && s.name && typeof s.cat === "string"));
  t.ok("SENDERS include cih and glovo", SENDERS.some(s => s.slug === "cih") && SENDERS.some(s => s.domains.indexOf("glovoapp.com") > -1));
  t.ok("KEYWORDS cover French and English", KEYWORDS.indexOf("paiement") > -1 && KEYWORDS.indexOf("receipt") > -1);

  /* --- htmlToText --- */
  const txt = htmlToText("<html><head><title>x</title><style>.a{color:red}</style></head><body>" +
    "<p>Caf&eacute; &amp; th&#233; &#xE9;t&eacute; &agrave; 12&nbsp;&euro;</p><script>var x=1;</script>" +
    "<table><tr><td>Total</td><td>85,00&nbsp;MAD</td></tr></table><div>  ligne   deux </div><br><br><br>fin</body></html>");
  t.has("entities decoded (é, &, à, €)", txt, "Café & thé été à 12 €");
  t.no("style/script/head content dropped", /color:red|var x|<|title/.test(txt), txt);
  t.has("table cells separated on one line", txt, "Total | 85,00 MAD");
  t.no("no empty lines, spaces collapsed", /\n\n|  /.test(txt), JSON.stringify(txt));
  t.eq("htmlToText(null) is empty", htmlToText(null), "");

  /* --- CIH-style card payment with the balance in the same mail --- */
  const pay = parseMail(mail({
    from: "CIH Bank <alertes@cihbank.ma>",
    subject: "Alerte : paiement par carte",
    text: "Cher client,\nUn paiement par carte n° ****1234 a été effectué chez MARJANE CALIFORNIA le 13/10/2026 à 18:42 " +
      "pour un montant de 1 250,00 MAD.\nSolde disponible : 8 430,55 MAD.\nCIH Bank"
  }));
  t.eq("CIH payment: amount is the payment, not the balance", field(pay, "amount"), 1250);
  t.eq("CIH payment: kind debit", field(pay, "kind"), "debit");
  t.eq("CIH payment: merchant after 'chez'", field(pay, "merchant"), "Marjane California");
  t.eq("CIH payment: date from body", field(pay, "date"), "2026-10-13");
  t.eq("CIH payment: source cih", field(pay, "source"), "cih");
  t.eq("CIH payment: grocery merchant categorised", field(pay, "cat"), "food");
  t.ok("CIH payment: confidence ~0.85", pay && pay.confidence >= 0.8 && pay.confidence <= 0.9, pay && pay.confidence);
  t.ok("masked card digits never become the amount", pay && pay.amount !== 1234);

  /* balance first, same sentence, structured layout */
  const pay2 = parseMail(mail({
    from: "CIH Bank <noreply@cihbank.ma>",
    subject: "Opération sur votre compte",
    text: "Solde disponible : 3 450,00 DH\nOpération : Achat par carte XXXX 9876\nMontant : 89,90 DH\nCommerçant : KFC MAARIF\nDate : 12/10/2026"
  }));
  t.eq("structured alert: 'Montant :' line wins over balance", field(pay2, "amount"), 89.9);
  t.eq("structured alert: 'Commerçant :' merchant", field(pay2, "merchant"), "KFC Maarif");

  const comma = parseMail(mail({ from: "CIH Bank <noreply@cihbank.ma>", subject: "Alerte débit",
    text: "Votre compte a été débité de 250,00 MAD, solde disponible 3 450,00 MAD" }));
  t.eq("debit and balance in one sentence split by a comma → the debit", field(comma, "amount"), 250);

  const onlyBal = parseMail(mail({ from: "CIH Bank <noreply@cihbank.ma>", subject: "Information",
    text: "Votre solde disponible au 14/10/2026 est de 12 300,00 MAD." }));
  t.eq("balance-only mail → null", onlyBal, null);

  /* --- cash withdrawal --- */
  const atm = parseMail(mail({
    from: "CIH Bank <alertes@cihbank.ma>", subject: "Retrait GAB",
    text: "Un retrait de 500,00 MAD a été effectué au GAB CIH CASABLANCA ANFA le 14/10/2026 avec votre carte ****5521. Nouveau solde : 2 100,00 MAD."
  }));
  t.eq("withdrawal: amount", field(atm, "amount"), 500);
  t.eq("withdrawal: merchant 'Cash withdrawal'", field(atm, "merchant"), "Cash withdrawal");
  t.eq("withdrawal: no category", field(atm, "cat"), "");
  t.eq("withdrawal: kind debit", field(atm, "kind"), "debit");

  /* --- credit / transfer received --- */
  const cred = parseMail(mail({
    from: "CIH Bank <alertes@cihbank.ma>", subject: "Virement reçu",
    text: "Votre compte a été crédité de 3 000,00 MAD suite à un virement reçu de la part de MOHAMED ALAMI le 10/10/2026."
  }));
  t.eq("credit: amount", field(cred, "amount"), 3000);
  t.eq("credit: kind credit", field(cred, "kind"), "credit");
  t.eq("credit: sender of the transfer", field(cred, "merchant"), "Mohamed Alami");

  const refund = parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Remboursement",
    text: "Remboursement de 120,00 MAD crédité sur votre carte ****1111 par JUMIA." }));
  t.eq("refund: kind refund", field(refund, "kind"), "refund");

  /* debit verb on an unknown (non-CIH) sender: still recognised, lower confidence */
  const other = parseMail(mail({ from: "Ma Banque <info@mabanque.example>", subject: "Card payment",
    text: "Your account has been debited MAD 45.00 for a card payment at CAFE CLOCK on Oct 13, 2026. Available balance: MAD 900.00" }));
  t.eq("English alert, unknown bank: amount", field(other, "amount"), 45);
  t.eq("English alert: merchant after 'at'", field(other, "merchant"), "Cafe Clock");
  t.ok("unknown bank sender is below CIH confidence", other && other.confidence < 0.85 && other.source === "generic", other && other.confidence);

  /* --- Glovo HTML receipt: subtotal, delivery, total --- */
  const glovo = parseMail(mail({
    from: "Glovo <no-reply@glovoapp.com>", subject: "Votre reçu Glovo",
    html: "<html><head><style>td{padding:4px}</style></head><body><h1>Merci pour votre commande !</h1>" +
      "<p>Commande n° 123456789 du 13/10/2026</p><table>" +
      "<tr><td>2x Tacos XL</td><td>110,00&nbsp;MAD</td></tr>" +
      "<tr><td>Sous-total</td><td>110,00&nbsp;MAD</td></tr>" +
      "<tr><td>Frais de livraison</td><td>12,00&nbsp;MAD</td></tr>" +
      "<tr><td>Frais de service</td><td>3,00&nbsp;MAD</td></tr>" +
      "<tr><td>R&eacute;duction</td><td>-20,00&nbsp;MAD</td></tr>" +
      "<tr><td><b>Total</b></td><td><b>105,00&nbsp;MAD</b></td></tr></table>" +
      "<p><a href='#'>Se d&eacute;sabonner</a></p></body></html>"
  }));
  t.eq("Glovo: picks Total, not subtotal/fees", field(glovo, "amount"), 105);
  t.eq("Glovo: merchant/cat/source", glovo && [glovo.merchant, glovo.cat, glovo.source].join("/"), "Glovo/food/glovo");
  t.ok("Glovo: known sender + total ≈ 0.9", glovo && glovo.confidence >= 0.85, glovo && glovo.confidence);
  t.eq("Glovo: order number not read as a date or amount; date from body", field(glovo, "date"), "2026-10-13");

  /* --- Careem --- */
  const careem = parseMail(mail({
    from: "Careem <receipts@careem.com>", subject: "Your ride receipt",
    text: "Thanks for riding with Careem\nTrip fare 38.00 MAD\nPromo -5.00 MAD\nTotal MAD 33.00\nPaid by card ending in 4242"
  }));
  t.eq("Careem: total amount", field(careem, "amount"), 33);
  t.eq("Careem: transport", careem && careem.merchant + "/" + careem.cat, "Careem/transport");

  /* --- Netflix, foreign currency --- */
  const nflx = parseMail(mail({
    from: "Netflix <info@mailer.netflix.com>", subject: "Votre facture Netflix",
    text: "Merci pour votre abonnement.\nForfait Standard\nTotal TTC : 12,99 €\nDate de facturation : 14 octobre 2026"
  }));
  t.eq("Netflix: amount", field(nflx, "amount"), 12.99);
  t.eq("Netflix: currency EUR", field(nflx, "currency"), "EUR");
  t.eq("Netflix: bills", field(nflx, "cat"), "bills");
  t.eq("Netflix: French textual date", field(nflx, "date"), "2026-10-14");

  /* --- Uber Eats vs Uber rides --- */
  const eats = parseMail(mail({ from: "Uber Receipts <noreply@uber.com>", subject: "Your Uber Eats order with Pizza Hut",
    text: "Thanks for ordering\nSubtotal MAD 120.00\nDelivery Fee MAD 9.00\nTip MAD 10.00\nTotal MAD 139.00" }));
  t.eq("Uber Eats: total", field(eats, "amount"), 139);
  t.eq("Uber Eats: food, merchant 'Uber Eats'", eats && eats.merchant + "/" + eats.cat, "Uber Eats/food");
  const ride = parseMail(mail({ from: "Uber Receipts <noreply@uber.com>", subject: "Your Thursday trip with Uber",
    text: "Thanks for riding\nTotal MAD 42.50" }));
  t.eq("Uber ride: transport", field(ride, "cat"), "transport");

  /* --- amount formats --- */
  const nb = parseMail(mail({ from: "inwi <factures@inwi.ma>", subject: "Votre facture",
    text: "Votre facture du mois est disponible.\nMontant total : 1 234,56 DH" }));
  t.eq("'1 234,56 DH' with NBSP thousands", field(nb, "amount"), 1234.56);
  const thin = parseMail(mail({ from: "Jumia <noreply@jumia.ma>", subject: "Confirmation de commande",
    text: "Votre commande a été confirmée.\nTotal payé : 2 499,00 Dhs" }));
  t.eq("narrow no-break space thousands + 'Dhs'", field(thin, "amount"), 2499);
  const dots = parseMail(mail({ from: "Orange <noreply@orange.ma>", subject: "Paiement de facture",
    text: "Merci pour votre paiement.\nMontant payé : 1.234,56 DHS" }));
  t.eq("'1.234,56 DHS'", field(dots, "amount"), 1234.56);
  const usd = parseMail(mail({ from: "Apple <no_reply@email.apple.com>", subject: "Your receipt from Apple",
    text: "Receipt\niCloud+ 50 GB\nTotal $5" }));
  t.ok("'$5' → 5 USD", usd && usd.amount === 5 && usd.currency === "USD", usd && usd.amount + " " + usd.currency);
  const dirhams = parseMail(mail({ from: "Yassir <noreply@yassir.com>", subject: "Reçu de votre course",
    text: "Merci d'avoir voyagé avec Yassir.\nTotal : 45 dirhams" }));
  t.eq("'45 dirhams'", field(dirhams, "amount"), 45);

  /* --- not transactions --- */
  t.eq("OTP email → null", parseMail(mail({ from: "CIH Bank <noreply@cihbank.ma>", subject: "Code de vérification",
    text: "Votre code de vérification pour le paiement de 250,00 MAD chez AMAZON est 482913. Il expire dans 5 minutes." })), null);
  t.eq("password alert → null", parseMail(mail({ from: "Netflix <info@netflix.com>", subject: "Nouvelle connexion à votre compte",
    text: "Quelqu'un s'est connecté. Total 0 appareil." })), null);
  t.eq("promo newsletter with prices → null", parseMail(mail({ from: "Glovo <promo@glovoapp.com>", subject: "-30% ce week-end !",
    html: "<h1>Profitez de -30%</h1><p>Pizza Margherita à 49,00 DH au lieu de 70,00 DH</p><p>Livraison gratuite dès 100 DH</p><a>Se désabonner</a>" })), null);
  t.eq("shipping notice without amount → null", parseMail(mail({ from: "Jumia <noreply@jumia.ma>", subject: "Votre commande a été expédiée",
    text: "Votre commande n° 300123456 est en route. Livraison prévue le 16/10/2026." })), null);
  t.eq("account statement → null", parseMail(mail({ from: "CIH Bank <noreply@cihbank.ma>", subject: "Votre relevé de compte de septembre",
    text: "Votre relevé est disponible. Total des débits : 4 500,00 MAD" })), null);
  t.eq("unknown sender, price but no receipt wording → null", parseMail(mail({ from: "Friend <friend@example.com>", subject: "Weekend",
    text: "The hotel costs 450 MAD per night, are you in?" })), null);
  t.eq("declined payment → null", parseMail(mail({ from: "CIH Bank <noreply@cihbank.ma>", subject: "Alerte",
    text: "Votre paiement par carte de 300,00 MAD chez ZARA a été refusé." })), null);

  const gen = parseMail(mail({ from: "\"Librairie Atlas\" <contact@librairie-atlas.example>", subject: "Votre reçu",
    text: "Merci pour votre achat.\nSous-total : 180,00 MAD\nTotal : 180,00 MAD" }));
  t.ok("generic sender + receipt wording + total ≈ 0.6", gen && gen.amount === 180 && gen.confidence >= 0.5 && gen.confidence <= 0.7 && gen.source === "generic",
    gen && JSON.stringify(gen));
  t.eq("generic sender: merchant from display name", field(gen, "merchant"), "Librairie Atlas");

  /* --- robustness --- */
  const weird = [undefined, null, 42, "x", {}, { from: null, subject: null, text: null, html: null },
    { html: "<" + "div>".repeat(50000) }, { text: "\u0000￿".repeat(1000) }, { from: {}, subject: [], date: "not a date", text: "Total 10 MAD" }];
  let threw = false, nonNull = 0;
  for (const w of weird) {
    try { if (parseMail(w) !== null) nonNull++; } catch (e) { threw = true; }
  }
  t.no("malformed input never throws", threw);
  t.eq("malformed input returns null", nonNull, 0);
  const noDate = parseMail(mail({ date: "garbage", from: "Spotify <no-reply@spotify.com>", subject: "Your Spotify receipt", text: "Total 59,99 MAD" }));
  t.ok("bad mail date still yields a YYYY-MM-DD date", noDate && /^\d{4}-\d{2}-\d{2}$/.test(noDate.date), noDate && noDate.date);
  const rfc = parseMail(mail({ date: "Tue, 13 Oct 2026 10:00:00 +0100", from: "Spotify <no-reply@spotify.com>", subject: "Your Spotify receipt", text: "Total 59,99 MAD" }));
  t.eq("RFC 2822 mail date used when body has none", field(rfc, "date"), "2026-10-13");
  const outputs = [pay, atm, cred, glovo, careem, nflx, eats, gen];
  t.ok("every result has the full contract shape", outputs.every(r => r && r.amount > 0 && /^(MAD|EUR|USD)$/.test(r.currency) &&
    /^(debit|credit|refund)$/.test(r.kind) && r.merchant && r.merchant.length <= 40 && /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    typeof r.cat === "string" && r.source && r.confidence >= 0 && r.confidence <= 1 && r.reason));
};
