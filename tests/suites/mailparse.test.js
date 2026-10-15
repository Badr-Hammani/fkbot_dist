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

  /* ===== round 2: QA regressions ===== */

  /* 1. promo amounts are vouchers, never spending */
  t.eq("R2.1 Careem '10 MAD off your next ride' → null", parseMail(mail({ from: "Careem <noreply@careem.com>", subject: "How was your ride?",
    text: "Get 10 MAD off your next ride with code RIDE10.\nRate your trip" })), null);
  t.eq("R2.1 Glovo on-its-way with '20 MAD off next time' → null", parseMail(mail({ from: "Glovo <no-reply@glovoapp.com>", subject: "Glovo",
    text: "Your order is on its way!\nEnjoy 20 MAD off next time with code YUMMY" })), null);
  const withPromo = parseMail(mail({ from: "Careem <receipts@careem.com>", subject: "Your ride receipt",
    text: "Thanks for riding with Careem\nTotal MAD 33.00\nGagnez 15 MAD sur votre prochaine course !" }));
  t.eq("R2.1 receipt with a promo footer keeps the total", field(withPromo, "amount"), 33);
  t.eq("R2.1 '50 DH offerts' alone → null", parseMail(mail({ from: "Jumia <noreply@jumia.ma>", subject: "Votre commande",
    text: "50 DH offerts sur votre prochaine commande avec le code JUMIA50" })), null);

  /* 2. total-family wording */
  const jt = parseMail(mail({ from: "Jumia <noreply@jumia.ma>", subject: "Confirmation de votre commande",
    text: "Merci pour votre commande\nArticle 399,00 Dhs\nLivraison 20,00 Dhs\nTotal à payer 419,00 Dhs" }));
  t.ok("R2.2 'Total à payer' is the total (419, ≥0.85)", jt && jt.amount === 419 && jt.confidence >= 0.85, jt && JSON.stringify(jt));
  t.eq("R2.2 'Total payé' (unknown sender)", field(parseMail(mail({ from: "Guichet <noreply@guichet.example>", subject: "Vos billets",
    text: "Vos billets pour le concert\nTotal payé : 300,00 MAD" })), "amount"), 300);
  t.eq("R2.2 'Montant TTC' beats 'Montant HT'", field(parseMail(mail({ from: "Lydec <facture@lydec.example>", subject: "Votre facture d'électricité",
    text: "Facture n° 123456\nMontant HT : 250,00 MAD\nMontant TTC : 287,50 MAD" })), "amount"), 287.5);
  t.eq("R2.2 'Montant à régler'", field(parseMail(mail({ from: "Orange <noreply@orange.ma>", subject: "Votre facture",
    text: "Votre facture est disponible\nMontant à régler : 149,00 DH" })), "amount"), 149);

  /* 3. bank phrasings */
  const ecom = parseMail(mail({ from: "Alertes <alertes@banque-exemple.example>", subject: "Alerte opération",
    text: "Paiement e-commerce de 120,00 EUR chez AMAZON.FR le 13/10/2026." }));
  t.eq("R2.3 e-commerce payment without carte/compte", ecom && [ecom.amount, ecom.currency, ecom.kind, ecom.merchant].join(" "), "120 EUR debit Amazon.fr");
  const ecom2 = parseMail(mail({ from: "Alertes <alertes@notif.example>", subject: "Alerte",
    text: "Paiement e-commerce de 89,00 MAD chez DECATHLON le 13/10/2026." }));
  t.eq("R2.3 e-commerce payment from a sender with no bank in its domain", field(ecom2, "amount"), 89);
  const vir = parseMail(mail({ from: "Alertes <alertes@banque-exemple.example>", subject: "Virement",
    text: "Votre virement de 2 000,00 MAD au profit de YOUSSEF BENNANI a été exécuté." }));
  t.eq("R2.3 'votre virement … au profit de X' → debit to X", vir && [vir.amount, vir.kind, vir.merchant].join(" "), "2000 debit Youssef Bennani");
  t.ok("R2.3 ambiguous virement scored ≈0.7", vir && vir.confidence >= 0.6 && vir.confidence <= 0.75, vir && vir.confidence);
  const awb = parseMail(mail({ from: "Attijariwafa bank <alertes@attijariwafabank.com>", subject: "Avis d'opération",
    html: "<table><tr><td>Opération</td><td>Paiement par carte</td></tr><tr><td>Montant</td><td>350,00 MAD</td></tr>" +
      "<tr><td>Commerçant</td><td>PHARMACIE AL AMAL</td></tr><tr><td>Date</td><td>13/10/2026</td></tr>" +
      "<tr><td>Solde disponible</td><td>4 200,00 MAD</td></tr></table>" }));
  t.eq("R2.3 table-layout alert: amount from 'Montant | …' cell", field(awb, "amount"), 350);
  t.eq("R2.3 table-layout alert: health merchant", awb && awb.merchant + "/" + awb.cat, "Pharmacie Al Amal/health");
  const cpay = parseMail(mail({ from: "Careem <noreply@careem.com>", subject: "Careem Pay",
    text: "You have received 150.00 MAD from Youssef via Careem Pay." }));
  t.eq("R2.3 Careem Pay 'You have received' → credit", cpay && [cpay.amount, cpay.kind, cpay.merchant].join(" "), "150 credit Careem Pay");
  const virIn = parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte",
    text: "Virement de 3 000,00 MAD reçu de la part de SARA ALAOUI." }));
  t.eq("R2.3 'Virement de X reçu' → credit", field(virIn, "kind"), "credit");

  /* 4. merchant extraction */
  const cell = parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte",
    html: "<table><tr><td>Opération</td><td>Achat par carte</td></tr><tr><td>Montant</td><td>350,00 MAD</td></tr><tr><td>Commerçant</td><td>PHARMACIE AL AMAL</td></tr></table>" }));
  t.eq("R2.4 'Commerçant | X' table cell", field(cell, "merchant"), "Pharmacie Al Amal");
  const soit = parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte",
    text: "Paiement par carte de 5,00 USD chez NETFLIX.COM soit 55,30 MAD le 13/10/2026." }));
  t.eq("R2.4 merchant stops at 'soit'", field(soit, "merchant"), "Netflix.com");
  t.eq("R2.4 merchant stops at \"d'un montant\"", field(parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte",
    text: "Achat chez CARREFOUR MARKET d'un montant de 412,30 MAD." })), "merchant"), "Carrefour Market");

  /* 5. shipping / delivery notices repeat the total → null */
  const amzOrder = parseMail(mail({ from: "Amazon.fr <auto-confirm@amazon.fr>", subject: "Votre commande Amazon.fr",
    text: "Merci pour votre commande\nTotal de la commande : EUR 25,99" }));
  t.eq("R2.5 Amazon order confirmation counts", field(amzOrder, "amount"), 25.99);
  t.eq("R2.5 Amazon 'expédiée' notice with the same total → null", parseMail(mail({ from: "Amazon.fr <shipment-tracking@amazon.fr>",
    subject: "Votre commande a été expédiée", text: "Votre colis est en route\nTotal de la commande : EUR 25,99" })), null);
  t.eq("R2.5 'out for delivery' → null", parseMail(mail({ from: "Amazon <shipment-tracking@amazon.com>", subject: "Out for delivery: your package",
    text: "Your package is out for delivery today.\nOrder total: $19.99" })), null);
  t.eq("R2.5 'delivered' notice → null", parseMail(mail({ from: "Jumia <noreply@jumia.ma>", subject: "Votre commande a été livrée",
    text: "Votre commande a été livrée. Total : 299,00 Dhs" })), null);

  /* 6. a footer mentioning 3D Secure / OTP does not kill a real receipt */
  const foot = parseMail(mail({ from: "Netflix <info@mailer.netflix.com>", subject: "Votre facture Netflix",
    text: "Merci pour votre abonnement.\nTotal TTC : 65,00 MAD\nVos paiements sont protégés par 3D Secure. Netflix ne vous demandera jamais votre mot de passe ou un code OTP." }));
  t.eq("R2.6 receipt with a 3D Secure / OTP footer still parses", field(foot, "amount"), 65);
  t.eq("R2.6 a 3D Secure code message is still null", parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte",
    text: "Votre code 3D Secure pour l'achat de 120,00 EUR chez AMAZON.FR est 739201." })), null);
  t.eq("R2.6 OTP in the subject is still null", parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Votre code OTP",
    text: "Paiement par carte de 120,00 MAD chez ZARA." })), null);

  /* ===== security: regex DoS (H1, M1) — each call must stay under 200 ms ===== */
  const timed = (fn) => { const t0 = Date.now(); let r; try { r = fn(); } catch (e) { r = "threw"; } return { ms: Date.now() - t0, r }; };
  const run1 = timed(() => parseMail(mail({ from: "CIH Bank <a@cihbank.ma>", subject: "Paiement", text: "Paiement " + "*x·".repeat(134) + " de 10 MAD" })));
  t.ok("DoS: 400-char '*x·' mask run < 200 ms", run1.ms < 200 && run1.r !== "threw", run1.ms + " ms");
  const run2 = timed(() => parseMail(mail({ from: "Shop <a@shop.example>", subject: "Votre reçu", text: "Total " + "123 ".repeat(51200) })));
  t.ok("DoS: 200 KB digit-group line < 200 ms", run2.ms < 200 && run2.r !== "threw", run2.ms + " ms");
  const run3 = timed(() => parseMail(mail({ from: "Glovo <a@glovoapp.com>", subject: "Reçu", html: "<br".repeat(27307) })));
  t.ok("DoS: 80 KB unclosed '<br' blob < 200 ms", run3.ms < 200 && run3.r !== "threw", run3.ms + " ms");
  const run3b = timed(() => htmlToText("<head <!-- <style ".repeat(16000)));
  t.ok("DoS: unclosed <head/<!--/<style blocks < 200 ms", run3b.ms < 200, run3b.ms + " ms");
  const run4 = timed(() => parseMail(mail({ from: "<".repeat(40000) + "a ".repeat(20000), subject: "Votre reçu", text: "Total 10 MAD" })));
  t.ok("DoS: 80 KB From header < 200 ms", run4.ms < 200 && run4.r !== "threw", run4.ms + " ms");
  const masked = parseMail(mail({ from: "CIH Bank <a@cihbank.ma>", subject: "Paiement",
    text: "Paiement par carte XXXX XXXX XXXX 4321 de 75,00 MAD chez ZARA. Carte **** 9876, carte ****5555." }));
  t.eq("card masks are still scrubbed after the regex fix", field(masked, "amount"), 75);

  /* ===== security: sender verification (L2) ===== */
  const glovoMail = (auth, from) => mail({ from: from || "Glovo <no-reply@glovoapp.com>", subject: "Votre reçu Glovo",
    text: "Merci pour votre commande\nTotal : 85,00 MAD", authResults: auth });
  const conf = (r) => (r ? r.confidence : -1);
  t.ok("DKIM absent: score unchanged (0.9)", conf(parseMail(glovoMail(undefined))) === 0.9, conf(parseMail(glovoMail(undefined))));
  t.ok("DKIM empty string: score unchanged", conf(parseMail(glovoMail(""))) === 0.9);
  t.ok("DKIM pass, header.i=@glovoapp.com: 0.9",
    conf(parseMail(glovoMail("mx.google.com; dkim=pass header.i=@glovoapp.com header.s=s1 header.b=AbC; spf=neutral"))) === 0.9);
  t.ok("DKIM pass, header.d=glovoapp.com: 0.9",
    conf(parseMail(glovoMail("mx.google.com; dkim=pass header.d=glovoapp.com header.s=s1"))) === 0.9);
  const sub = parseMail(mail({ from: "Netflix <info@mailer.netflix.com>", subject: "Votre facture Netflix", text: "Total TTC : 65,00 MAD",
    authResults: "mx.google.com; dkim=pass header.i=@netflix.com header.s=x" }));
  t.ok("DKIM pass on the parent of a subdomain sender (mailer.netflix.com / netflix.com): 0.9", conf(sub) === 0.9, conf(sub));
  const spf = conf(parseMail(glovoMail("mx.google.com; dkim=none; spf=pass (google.com: domain of bounce@mail.glovoapp.com designates 1.2.3.4) smtp.mailfrom=bounce@mail.glovoapp.com")));
  t.ok("SPF pass on a matching subdomain counts as verified: 0.9", spf === 0.9, spf);
  const forged = parseMail(glovoMail("mx.google.com; dkim=pass header.i=@evil.com header.s=s1; spf=pass smtp.mailfrom=evil.com"));
  t.ok("forged From (dkim=pass for evil.com): −0.3 → 0.6", conf(forged) === 0.6, conf(forged));
  t.has("forged From: reason says so", forged && forged.reason, "not verified");
  const failed = conf(parseMail(glovoMail("mx.google.com; dkim=fail header.i=@glovoapp.com; spf=softfail smtp.mailfrom=glovoapp.com")));
  t.ok("dkim=fail on the right domain: −0.3", failed === 0.6, failed);
  const suffix = conf(parseMail(glovoMail("mx.google.com; dkim=pass header.d=com")));
  t.ok("a pass for a bare public suffix ('com') is not a match", suffix === 0.6, suffix);
  const cihForged = conf(parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte",
    text: "Paiement par carte de 250,00 MAD chez ZARA.", authResults: "mx.google.com; dkim=pass header.i=@phish.example" })));
  t.ok("forged CIH alert: 0.85 − 0.3", cihForged === 0.55, cihForged);

  /* ===== round 3 ===== */

  /* 1. incoming transfers are credits, whatever the word order */
  const cihMail = (text) => mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte", text });
  const incoming = [
    ["Vous avez reçu un virement de 8 500,00 MAD de la part de SAMIR ALAMI.", 8500],
    ["Un virement de 3 000 MAD a été reçu sur votre compte.", 3000],
    ["Votre compte a été crédité d'un virement de 1 200,00 MAD.", 1200],
    ["Virement en votre faveur de 4 000,00 MAD.", 4000],
    ["Virement entrant de 2 500,00 MAD.", 2500],
    ["Réception d'un virement de 900,00 MAD.", 900],
    ["Un virement de 750,00 MAD a été reçue.", 750]
  ];
  for (const [text, amt] of incoming) {
    const r = parseMail(cihMail(text));
    t.eq("R3.1 credit: " + text.slice(0, 48), r && r.kind + " " + r.amount, "credit " + amt);
  }
  t.eq("R3.1 'Vous avez reçu un virement … de la part de X' names X", field(parseMail(cihMail(incoming[0][0])), "merchant"), "Samir Alami");
  t.eq("R3.1 outgoing 'virement émis' stays a debit", field(parseMail(cihMail("Virement émis de 1 000,00 MAD au profit de KARIM.")), "kind"), "debit");

  /* 2. failed payments, price changes, renewal reminders → null even from known senders */
  const notYet = [
    ["Netflix <info@mailer.netflix.com>", "Problème de paiement", "We couldn't process your payment of €13.49. Total: €13.49"],
    ["Netflix <info@mailer.netflix.com>", "Votre facture", "Votre paiement a échoué. Montant total : 65,00 MAD"],
    ["Spotify <no-reply@spotify.com>", "Votre abonnement", "Votre paiement a été refusé. Total 59,99 MAD"],
    ["Spotify <no-reply@spotify.com>", "Changes to your plan", "Your price is changing to €15.99 per month. Total €15.99"],
    ["inwi <factures@inwi.ma>", "Votre abonnement", "Votre abonnement sera renouvelé le 30/10/2026 pour 59 MAD. Montant total : 59 MAD"],
    ["Apple <no_reply@email.apple.com>", "Your subscription will renew", "Your subscription will renew on 20 Oct 2026. Total $9.99"],
    ["Spotify <no-reply@spotify.com>", "Upcoming payment", "Your upcoming payment of 59,99 MAD. Total 59,99 MAD"],
    ["Orange <noreply@orange.ma>", "Rappel de paiement", "Facture à venir. Montant total : 199,00 DH"]
  ];
  for (const [from, subject, text] of notYet) t.eq("R3.2 null: " + subject + " / " + text.slice(0, 30), parseMail(mail({ from, subject, text })), null);
  const appleRenews = parseMail(mail({ from: "Apple <no_reply@email.apple.com>", subject: "Your receipt from Apple",
    text: "Receipt\niCloud+ 50 GB Monthly Renews 20 Nov 2026\nTotal $0.99" }));
  t.eq("R3.2 a real receipt that prints 'Renews …' still counts", field(appleRenews, "amount"), 0.99);

  /* failed-payment wording counts only as the mail's own statement */
  t.eq("R3.2b conditional 'En cas de paiement refusé…' keeps a real Glovo receipt", field(parseMail(mail({ from: "Glovo <no-reply@glovoapp.com>",
    subject: "Votre commande Glovo", text: "Total : 94,00 MAD\nMerci ! En cas de paiement refusé par votre banque, contactez le support." })), "amount"), 94);
  t.eq("R3.2b French conditional 'Si votre paiement échoue…' keeps the receipt", field(parseMail(mail({ from: "Jumia <noreply@jumia.ma>",
    subject: "Confirmation de commande", text: "Merci pour votre commande\nTotal payé : 250,00 Dhs\nSi votre paiement a échoué, aucun montant ne sera débité." })), "amount"), 250);
  t.eq("R3.2b English conditional 'If your payment is declined…' keeps the receipt", field(parseMail(mail({ from: "Uber Receipts <noreply@uber.com>",
    subject: "Your Thursday trip with Uber", text: "Thanks for riding\nTotal MAD 42.50\nIf your payment is declined, we will retry your card." })), "amount"), 42.5);
  t.eq("R3.2b typographic apostrophe: 'We couldn’t process your payment' → null", parseMail(mail({ from: "Netflix <info@mailer.netflix.com>",
    subject: "Problème de paiement", text: "We couldn’t process your payment of €13.49." })), null);
  t.eq("R3.2b 'Payment issue' subject → null", parseMail(mail({ from: "Spotify <no-reply@spotify.com>",
    subject: "Payment issue with your account", text: "Total 59,99 MAD" })), null);
  t.eq("R3.2b failed wording on the amount's own sentence → null", parseMail(mail({ from: "CIH Bank <alertes@cihbank.ma>", subject: "Alerte",
    text: "Paiement par carte de 300,00 MAD chez ZARA refusé." })), null);

  /* 3. deposits: the amount paid, never what is still owed */
  t.eq("R3.3 'Acompte versé' over 'Reste à payer'", field(parseMail(mail({ from: "Riad <contact@riad.example>", subject: "Votre réservation",
    text: "Merci pour votre réservation\nAcompte versé : 500,00 MAD\nReste à payer : 1 500,00 MAD" })), "amount"), 500);
  t.eq("R3.3 'Deposit paid' over 'Remaining balance' and 'Total'", field(parseMail(mail({ from: "Hotel <x@hotel.example>", subject: "Booking confirmation",
    text: "Thank you for your booking\nDeposit paid: 500.00 MAD\nRemaining balance: 1,500.00 MAD\nTotal: 2,000.00 MAD" })), "amount"), 500);
  t.eq("R3.3 'Montant payé' over 'Montant restant'", field(parseMail(mail({ from: "Ecole <x@ecole.example>", subject: "Reçu de paiement",
    text: "Montant payé : 500,00 MAD\nMontant restant : 1 500,00 MAD" })), "amount"), 500);
  t.eq("R3.3 only a remaining amount → null", parseMail(mail({ from: "Hotel <x@hotel.example>", subject: "Votre réservation",
    text: "Merci pour votre réservation\nSolde restant : 1 500,00 MAD\nMontant restant à régler sur place" })), null);

  /* 4. promo bonus excluded, the real price kept */
  const recharge = parseMail(mail({ from: "inwi <noreply@inwi.ma>", subject: "Confirmation de recharge",
    text: "Votre recharge de 50 DH a été effectuée avec succès. 10 DH offerts !" }));
  t.eq("R3.4 inwi recharge with '10 DH offerts' → 50", recharge && recharge.amount + " " + recharge.merchant, "50 inwi");

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

  /* ---- loop round 1: bank fees are not the payment (synthetic) ---- */
  const cih = (subject, text) => M.parseMail({ id: "fx", from: "CIH Bank <alertes@cihbank.ma>", subject, date: "2026-10-14T10:00:00Z", text });
  const feeFirst = cih("Virement émis", "Frais de virement de 5,00 MAD. Votre virement de 2 000,00 MAD au profit de AHMED a été effectué.");
  t.eq("a fee sentence before the transfer: the transfer is the amount", feeFirst && feeFirst.amount, 2000);
  const feeAfter = cih("Virement émis", "Votre virement de 2 000,00 MAD au profit de AHMED a été effectué. Frais de virement : 5,00 MAD.");
  t.eq("a fee sentence after it: still the transfer", feeAfter && feeAfter.amount, 2000);
  const feeOnly = cih("Frais bancaires", "Frais de virement de 5,00 MAD prélevés sur votre compte.");
  t.ok("a mail that is only a fee is that fee, filed as a bank fee", feeOnly && feeOnly.amount === 5 && feeOnly.kind === "debit" &&
    feeOnly.merchant === "CIH Bank fees" && feeOnly.cat === "bills", JSON.stringify(feeOnly));
  const atmFee = cih("Retrait", "Retrait GAB de 500,00 MAD. Frais de retrait : 6,00 MAD. Solde disponible : 1 200,00 MAD");
  t.eq("a withdrawal with its fee: the withdrawal", atmFee && atmFee.amount, 500);
  const cardComm = cih("Paiement par carte", "Paiement par carte ****4521 d'un montant de 120,00 EUR chez AMAZON.FR. Commission : 3,50 MAD.");
  t.ok("a card payment with a commission: the payment", cardComm && cardComm.amount === 120 && cardComm.currency === "EUR");
};
