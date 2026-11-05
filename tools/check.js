#!/usr/bin/env node
// Print what the Lens decides for a profile, dish by dish, without the glasses.
//
//   node tools/check.js --profile milk,peanut                 # every restaurant + product
//   node tools/check.js --profile beef,pork --restaurant laurel-cafe
//   node tools/check.js --profile milk --url http://<gx10-ip>:8787/menus.json   # the live server instead of the bundled data
//   node tools/check.js --list                                # profile ids, restaurants, products
//
// Uses the SAME compiled checker the Lens runs (Lens Studio writes it to Cache/TypeScript/Out when
// the project compiles), so this is the Lens logic, not a copy. Open the project in Lens Studio once
// if the Cache folder is missing.
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "Cache", "TypeScript", "Out", "Modules", "Src", "Assets");
if (!fs.existsSync(path.join(out, "Scripts", "AllergyLensChecker.js"))) {
  console.error("Compiled scripts not found under Cache/TypeScript/Out — open AllergyLens.esproj in Lens Studio once so it compiles, then rerun.");
  process.exit(1);
}
const checker = require(path.join(out, "Scripts", "AllergyLensChecker.js"));
const data = require(path.join(out, "Data", "AllergyData.js"));
const menuData = require(path.join(out, "Scripts", "AllergyLensMenuData.js"));

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
if (args.includes("--list")) {
  console.log("profile ids:", data.ALLERGENS.map((a) => `${a.id} (${a.group})`).join(", "));
  console.log("restaurants:", data.RESTAURANTS.map((r) => `${r.id} (${r.dishes.length} dishes)`).join(", "));
  console.log("products:", data.PRODUCTS.map((p) => `${p.barcode} ${p.name}`).join("; "));
  process.exit(0);
}
const profileIds = (opt("--profile", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const onlyRestaurant = opt("--restaurant", null);
const url = opt("--url", null);
const profile = new checker.Profile();
for (const id of profileIds) {
  if (!data.ALLERGENS.some((a) => a.id === id)) {
    console.error(`unknown profile id "${id}" — run with --list`);
    process.exit(1);
  }
  profile.set(id, true);
}

async function restaurants() {
  if (!url) return data.RESTAURANTS;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const json = await res.json();
  const validated = menuData.validateMenus(json); // the same validation the Lens runs on a fetched menus.json
  if (!validated) throw new Error("menus.json shape not recognised — the Lens would keep its bundled data");
  console.log(`(live) ${url}: ${validated.length} restaurants accepted by the Lens validator\n`);
  return validated;
}

const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const colour = { safe: "GREEN ", contains: "RED   ", unverified: "AMBER ", none: "-     " };

(async () => {
  const list = (await restaurants()).filter((r) => !onlyRestaurant || r.id === onlyRestaurant);
  console.log(`profile: [${profileIds.join(", ") || "empty"}]\n`);
  for (const r of list) {
    const results = checker.checkMenu(r.dishes, profile);
    const badge = checker.rateRestaurant(r, profile);
    console.log(`== ${r.name} (${r.id}) — badge ${badge.level.toUpperCase()}: ${badge.safeCount} of ${badge.total} safe`);
    for (const d of r.dishes) {
      const res = results.find((x) => x.dishId === d.id);
      const cat = menuData.dishCategory ? menuData.dishCategory(d) : d.category;
      const src = res.source === "restaurant" ? "menu says" : res.source === "typical" ? "typical  " : "unknown  ";
      let why = "";
      if (res.verdict === "contains") {
        const t = checker.describeChoice(d, res, r, results);
        why = `${t.headline} ${t.body.replace(/\n/g, " ")}`;
      }
      console.log(`  ${colour[res.verdict]} ${pad(d.name, 26)} ${pad(cat, 10)} ${src}  ${why}`);
    }
    console.log();
  }
  if (!onlyRestaurant) {
    console.log("== Products (Open Food Facts)");
    for (const p of data.PRODUCTS) {
      const res = checker.checkProduct(p, profile);
      const t = checker.describeProduct(p, res);
      console.log(`  ${colour[res.verdict]} ${pad(p.name, 40)} ${checker.productChipText(res)}  |  ${t.headline}`);
    }
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
