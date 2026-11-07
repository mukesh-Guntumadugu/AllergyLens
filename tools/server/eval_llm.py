#!/usr/bin/env python3
"""Accuracy test, server half: ask the model about dishes whose ingredients we already know from a better
source (printed on the restaurant's own menu, or researched from cited recipes), WITHOUT giving it the answer,
and write both lists side by side. The Mac half (tools/eval_llm.js) runs the Lens's own checker on both lists
and reports, per allergen, how often the model's verdict agrees with the trusted one.

    cd /root/allergylens && set -a && . /etc/allergylens.env && set +a
    .venv/bin/python tools/server/eval_llm.py --n 150 --out data/eval-llm.json
"""
import argparse, json, os, random, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import serve_data as sd  # noqa: E402

ROOT = sd.ROOT


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "eval-llm.json"))
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    provider, model = sd._llm_provider()
    if not provider:
        print("no key in the environment", file=sys.stderr); return 1
    sd._llm_stats["provider"], sd._llm_stats["model"] = provider, model

    truth = []
    served = json.load(open(os.path.join(ROOT, "data", "menus.lens.json"), encoding="utf-8"))
    for r in served["restaurants"]:
        for d in r["dishes"]:
            if d.get("ingredientsSource") == "restaurant" and len(d.get("ingredients") or []) >= 3:
                truth.append({"name": d["name"], "cuisine": r.get("cuisine"), "truth": d["ingredients"], "truthSource": "printed on the menu"})
    gold = os.path.join(ROOT, "data-lake", "gold", "dishes.json")
    if os.path.exists(gold):
        for d in json.load(open(gold, encoding="utf-8"))["dishes"]:
            if d.get("status") == "typical" and len(d.get("typicalIngredients") or []) >= 3 and d.get("evidence"):
                truth.append({"name": d["name"], "cuisine": d.get("cuisine"), "truth": d["typicalIngredients"], "truthSource": "cited recipes"})
    random.Random(a.seed).shuffle(truth)
    sample = truth[: a.n]
    print(f"ground-truth dishes available: {len(truth)}; testing {len(sample)} with {provider} {model}")
    rows = []
    for i, t in enumerate(sample, 1):
        try:
            g = sd._llm_guess(t["name"], t["cuisine"])
            e = sd._llm_entry(t["name"], t["cuisine"], g)
            rows.append({**t, "model": e["typicalIngredients"], "modelStatus": e["status"], "diet": e.get("diet")})
        except Exception as ex:
            rows.append({**t, "model": [], "modelStatus": "error", "error": str(ex)})
        if i % 25 == 0:
            print(f"  {i}/{len(sample)}", flush=True)
        time.sleep(0.4)
    json.dump({"provider": provider, "model": model, "tokens": sd._llm_stats, "rows": rows}, open(a.out, "w", encoding="utf-8"), indent=1)
    print(f"wrote {a.out}: {len(rows)} rows; tokens {sd._llm_stats['input_tokens']} in / {sd._llm_stats['output_tokens']} out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
