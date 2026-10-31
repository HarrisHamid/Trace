"""Reviewer tooling: sampling, flow chains and file accounting for a built graph.

python scripts/verify.py sample   --graph out/graph.json --repo repos/fastapi-template [--kind calls|uncertain|fallback_external]
python scripts/verify.py flow     --graph out/graph.json --repo ... --route "POST /api/v1/login/access-token"
python scripts/verify.py files    --graph out/graph.json --repo ... --root backend
"""

from __future__ import annotations

import argparse
import json
import os
import random
from collections import defaultdict

SEED = 20261029


def load(path):
    with open(path) as fh:
        return json.load(fh)


def src_line(repo, file, line):
    with open(os.path.join(repo, file), encoding="utf-8") as fh:
        return fh.read().splitlines()[line - 1].strip()


def cmd_sample(g, repo, kind, n):
    nodes = {x["id"]: x for x in g["nodes"]}
    if kind == "calls":
        pool = [e for e in g["edges"] if e["type"] == "calls"]
    elif kind == "uncertain":
        pool = [e for e in g["edges"] if e["type"] == "uncertain"]
    else:
        pool = [e for e in g["external_calls"] if e["evidence"] != "jedi_definition"]
    rng = random.Random(SEED)
    sample = rng.sample(pool, min(n, len(pool)))
    print(f"# {kind}: sampled {len(sample)} of {len(pool)} (seed {SEED})")
    for i, e in enumerate(sample, 1):
        file = nodes[e["source"]]["file"]
        print(f"[{i:2}] {file}:{e['line']}  in {e['source']}")
        print(f"     src:    {src_line(repo, file, e['line'])}")
        print(f"     callee: {e['callee']}")
        if kind == "calls":
            t = nodes[e["target"]]
            print(f"     target: {t['id']}  ({t['file']}:{t['start_line']})  {t['signature']}")
        elif kind == "uncertain":
            print(f"     reason: {e['reason']}")
        else:
            print(f"     evidence: {e['evidence']}")


def cmd_flow(g, repo, route, max_depth):
    nodes = {x["id"]: x for x in g["nodes"]}
    out = defaultdict(list)
    for e in g["edges"]:
        out[e["source"]].append(e)
    ext = defaultdict(list)
    for e in g["external_calls"]:
        ext[e["source"]].append(e)
    inj_bad = defaultdict(list)
    for e in g["unresolved_injections"]:
        inj_bad[e["source"]].append(e)
    rid = f"route:{route}"
    if rid not in nodes:
        print(f"route not found: {route}")
        return
    seen = set()

    def show(nid, depth, label):
        n = nodes[nid]
        loc = f"{n['file']}:{n['start_line']}"
        print(f"{'  ' * depth}{label}{nid}  [{loc}]")
        if nid in seen or depth > max_depth:
            if nid in seen and out[nid]:
                print(f"{'  ' * (depth + 1)}(already expanded)")
            return
        seen.add(nid)
        for e in sorted(out[nid], key=lambda e: (e["type"] != "routes_to", e["type"] != "injects", e["line"])):
            if e["type"] == "routes_to":
                show(e["target"], depth + 1, "routes_to -> ")
            elif e["type"] == "injects":
                show(e["target"], depth + 1, f"injects({e['via']}) L{e['line']} -> ")
            elif e["type"] == "calls":
                show(e["target"], depth + 1, f"calls L{e['line']} {e['callee']}() -> ")
            elif e["type"] == "uncertain":
                print(f"{'  ' * (depth + 1)}?? BREAK L{e['line']} {e['callee']}()  reason={e['reason']}")
        for e in inj_bad[nid]:
            print(f"{'  ' * (depth + 1)}~~ injects {e['expr']} L{e['line']} not a node ({e['reason']})")
        for e in ext[nid]:
            if e["callee"].startswith(("session.", "select", "jwt.", "password_hash.")) or "session" in e["callee"].lower():
                print(f"{'  ' * (depth + 1)}ext L{e['line']} {e['callee']}()  [{e['evidence']}]")

    show(rid, 0, "")


def cmd_files(g, repo, root):
    base = os.path.join(repo, root)
    all_py = set()
    for dp, dns, fns in os.walk(base):
        for f in fns:
            if f.endswith(".py"):
                all_py.add(os.path.relpath(os.path.join(dp, f), repo).replace(os.sep, "/"))
    included = set(g["meta"]["included_files"])
    excluded = {d["path"] for d in g["meta"]["excluded_files"]}
    dirs = [d["path"] + "/" for d in g["meta"]["excluded_dirs"]]
    under_dirs = {p for p in all_py if any(p.startswith(d) for d in dirs)}
    unaccounted = all_py - included - excluded - under_dirs
    parsed_modules = {x["file"] for x in g["nodes"] if x["type"] == "module"}
    print(f".py files under {root}: {len(all_py)}")
    print(f"  included: {len(included)}  modules with a node: {len(parsed_modules)}")
    print(f"  excluded by dir rule: {len(under_dirs)}  excluded by file rule: {len(excluded)}")
    print(f"  unaccounted: {len(unaccounted)} {sorted(unaccounted)}")
    print(f"  included but no module node (silently skipped): {sorted(included - parsed_modules)}")
    print(f"  parse failures: {json.dumps(g['meta']['parse_failures'], indent=1)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["sample", "flow", "files"])
    ap.add_argument("--graph", default="out/graph.json")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--root", default=".")
    ap.add_argument("--kind", default="calls", choices=["calls", "uncertain", "fallback_external"])
    ap.add_argument("-n", type=int, default=20)
    ap.add_argument("--route")
    ap.add_argument("--depth", type=int, default=6)
    a = ap.parse_args()
    g = load(a.graph)
    if a.cmd == "sample":
        cmd_sample(g, a.repo, a.kind, a.n)
    elif a.cmd == "flow":
        cmd_flow(g, a.repo, a.route, a.depth)
    else:
        cmd_files(g, a.repo, a.root)


if __name__ == "__main__":
    main()
