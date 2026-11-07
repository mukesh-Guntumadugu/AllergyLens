#!/usr/bin/env python3
"""One-time pre-fill: every served dish with no ingredients goes through the small model once, so the
Lens never waits at the table. Runs on the server next to the key (reads /etc/allergylens.env itself):

    cd /root/allergylens && set -a && . /etc/allergylens.env && set +a
    .venv/bin/python tools/server/prefill.py [--limit N] [--rate 2] [--dry-run]

Reads data/menus.lens.json (the served file), dedupes dish names, skips names any catalog already knows
(seed, lake gold, data/lookup-cache.json), asks the model for the rest at --rate calls/second, and appends
each answer to data/lookup-cache.json through the server's own writer, so it is resumable: stop it, start
it again, it carries on. Non-dishes ("choose two sides") come back unknown and are listed in
data/lookup-unknown.txt so they are not asked again. Afterwards `systemctl restart allergylens-api`
rebuilds the served file with the new ingredients joined in (build-data.js reads the cache).
"""
import argparse, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import serve_data as sd   # noqa: E402  (the server module; main() only runs under __main__)

ROOT = sd.ROOT
UNKNOWN_LIST = os.path.join(ROOT, "data", "lookup-unknown.txt")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=0, help="stop after N model calls (0 = all)")
    ap.add_argument("--rate", type=float, default=2.0, help="model calls per second")
    ap.add_argument("--dry-run", action="store_true", help="count and list, call nothing")
    a = ap.parse_args()

    provider, model = sd._llm_provider()
    if not provider and not a.dry_run:
        print("no OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY in the environment", file=sys.stderr)
        return 1
    sd._llm_stats["provider"], sd._llm_stats["model"] = provider, model

    served = json.load(open(os.path.join(ROOT, "data", "menus.lens.json"), encoding="utf-8"))
    known_unknown = set()
    if os.path.exists(UNKNOWN_LIST):
        known_unknown = {l.strip() for l in open(UNKNOWN_LIST, encoding="utf-8") if l.strip()}
    todo = {}   # norm name -> (display name, cuisine)
    total = 0
    for r in served["restaurants"]:
        for d in r["dishes"]:
            if d.get("ingredients"):
                continue
            total += 1
            key = sd._norm(d["name"])
            if len(key) < 3 or key in todo or key in known_unknown:
                continue
            if sd.find_dish(d["name"]):
                continue
            todo[key] = (d["name"].strip(), r.get("cuisine"))
    print(f"served dishes without ingredients: {total}; distinct names to ask: {len(todo)}; "
          f"already marked not-a-dish: {len(known_unknown)}; provider: {provider} {model}")
    if a.dry_run:
        for k, (n, c) in list(todo.items())[:30]:
            print("  ", n, f"({c})" if c else "")
        return 0

    asked = filled = unknown = failed = 0
    t_start = time.time()
    for key, (name, cuisine) in todo.items():
        if a.limit and asked >= a.limit:
            break
        t0 = time.time()
        try:
            entry = sd._llm_entry(name, cuisine, sd._llm_guess(name, cuisine))
            asked += 1
            if entry["status"] == "typical":
                sd._write_local_cache(entry)
                filled += 1
            else:
                unknown += 1
                with open(UNKNOWN_LIST, "a", encoding="utf-8") as f:
                    f.write(key + "\n")
        except Exception as e:
            failed += 1
            asked += 1
            print(f"  ! {name}: {e}", file=sys.stderr)
            if "401" in str(e) or "rejected" in str(e) or "402" in str(e) or "insufficient" in str(e).lower():
                print("stopping: the key or the credit is the problem", file=sys.stderr)
                break
            time.sleep(5)
        if asked % 25 == 0:
            el = time.time() - t_start
            print(f"  {asked}/{len(todo)} asked, {filled} filled, {unknown} not a dish, {failed} failed, "
                  f"{sd._llm_stats['input_tokens']} in / {sd._llm_stats['output_tokens']} out tokens, {el/60:.1f} min", flush=True)
        time.sleep(max(0.0, 1.0 / a.rate - (time.time() - t0)))
    print(f"done: {asked} asked, {filled} filled, {unknown} not a dish, {failed} failed; "
          f"tokens {sd._llm_stats['input_tokens']} in / {sd._llm_stats['output_tokens']} out; {(time.time()-t_start)/60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
