#!/usr/bin/env node
// Accuracy test, Mac half: run the Lens's own checker on the trusted ingredient list and on the model's list
// for the same dish, for every single-allergen profile, and count agreements.
//
//   scp root@<vps>:/root/allergylens/data/eval-llm.json /tmp/eval-llm.json && node tools/eval_llm.js /tmp/eval-llm.json
//
// "contains" from the trusted list is the reference. Per allergen we report: hits (both say contains),
// misses (trusted says contains, model does not: the dangerous case), false alarms (model says contains,
// trusted does not: an unnecessary red), and the dish-level verdict agreement.
const path = require("path");
const fs = require("fs");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "Cache", "TypeScript", "Out", "Modules", "Src", "Assets");
const checker = require(path.join(out, "Scripts", "AllergyLensChecker.js"));
const data = require(path.join(out, "Data", "AllergyData.js"));

const file = process.argv[2];
if (!file) { console.error("usage: node tools/eval_llm.js <eval-llm.json>"); process.exit(1); }
const ev = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = ev.rows.filter((r) => r.modelStatus === "typical");
console.log(`${ev.rows.length} dishes tested with ${ev.provider} ${ev.model}; model knew ${rows.length}, ` +
  `${ev.rows.filter((r) => r.modelStatus === "unknown").length} unknown, ${ev.rows.filter((r) => r.modelStatus === "error").length} errors\n`);

const mkDish = (name, ings) => ({ id: "x", name, icon: null, ingredients: ings.map((s) => String(s).toLowerCase()), ingredientsSource: "typical",
  removable: [], shares: {}, substitutes: {}, layout: null, category: "unknown", price: null, section: null, markers: [] });
const verdict = (dish, allergenId) => { const p = new checker.Profile(); p.set(allergenId, true); return checker.checkMenu([dish], p)[0].verdict; };

const pad = (s, n) => (String(s).length >= n ? String(s).slice(0, n) : String(s) + " ".repeat(n - String(s).length));
console.log(pad("allergen", 14) + pad("trusted=contains", 18) + pad("hit", 6) + pad("MISS", 6) + pad("false alarm", 13) + "agreement");
let totHit = 0, totMiss = 0, totFa = 0, totAgree = 0, totN = 0;
const misses = [];
for (const a of data.ALLERGENS) {
  let hit = 0, miss = 0, fa = 0, agree = 0, pos = 0;
  for (const r of rows) {
    const t = verdict(mkDish(r.name, r.truth), a.id);
    const m = verdict(mkDish(r.name, r.model), a.id);
    if (t === "contains") pos++;
    if (t === "contains" && m === "contains") hit++;
    else if (t === "contains" && m !== "contains") { miss++; misses.push(`${a.id}: ${r.name} — trusted [${r.truth.join(", ")}] vs model [${r.model.join(", ")}]`); }
    else if (t !== "contains" && m === "contains") fa++;
    if (t === m) agree++;
  }
  totHit += hit; totMiss += miss; totFa += fa; totAgree += agree; totN += rows.length;
  console.log(pad(a.id, 14) + pad(pos, 18) + pad(hit, 6) + pad(miss, 6) + pad(fa, 13) + `${((100 * agree) / rows.length).toFixed(0)}%`);
}
console.log(`\nall allergens: ${totHit} hits, ${totMiss} misses, ${totFa} false alarms, ${((100 * totAgree) / totN).toFixed(1)}% verdict agreement ` +
  `(${totHit + totMiss ? ((100 * totHit) / (totHit + totMiss)).toFixed(0) : "-"}% of trusted "contains" caught)`);
if (misses.length) { console.log(`\nmisses (trusted says contains, model did not), first ${Math.min(25, misses.length)}:`); for (const m of misses.slice(0, 25)) console.log("  " + m); }
