"""Reviewer tooling: sampling, flow chains and file accounting for a built graph.

Reads graph.json and the report.json beside it.

python scripts/verify.py sample   --graph out/graph.json --repo third_party/fastapi-template [--kind calls|uncertain|fallback_external]
python scripts/verify.py flow     --graph out/graph.json --repo ... --route "POST /api/v1/login/access-token"
python scripts/verify.py files    --graph out/graph.json --repo ... --root backend
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
from collections import defaultdict

SEED = 20261029
LIBRARY_STEP = re.compile(r"session\.|select|jwt|password_hash", re.IGNORECASE)  # library calls worth showing in a flow


def load(path):
    with open(path) as fh:
        return json.load(fh)


def src_line(repo, file, line):
    with open(os.path.join(repo, file), encoding="utf-8") as fh:
        return fh.read().splitlines()[line - 1].strip()


def cmd_sample(g, r, repo, kind, n):
    nodes = {x["id"]: x for x in g["nodes"]}
    if kind == "calls":
        pool = [c for c in r["call_sites"] if c["kind"] == "resolved"]
    elif kind == "uncertain":
        pool = [c for c in r["call_sites"] if c["kind"] == "uncertain"]
    else:
        pool = [c for c in r["call_sites"] if c["kind"] == "external" and c["reason"] != "jedi_definition"]
    rng = random.Random(SEED)
    sample = rng.sample(pool, min(n, len(pool)))
    print(f"# {kind}: sampled {len(sample)} of {len(pool)} (seed {SEED})")
    for i, c in enumerate(sample, 1):
        file = nodes[c["source"]]["file"]
        print(f"[{i:2}] {file}:{c['line']}  in {c['source']}")
        print(f"     src:    {src_line(repo, file, c['line'])}")
        print(f"     callee: {c['callee']}")
        if kind == "calls":
            t = nodes[c["target"]]
            print(f"     target: {t['id']}  ({t['file']}:{t['line_start']})  {t['signature']}")
        elif kind == "uncertain":
            print(f"     reason: {c['reason']}")
        else:
            print(f"     target: {c['target']}  evidence: {c['reason']}")


def cmd_flow(g, repo, route, max_depth):
    nodes = {x["id"]: x for x in g["nodes"]}
    out = defaultdict(list)
    for e in g["edges"]:
        out[e["source"]].append(e)
    rid = next((x["id"] for x in g["nodes"] if x["type"] == "route" and x["name"] == route), None)
    if rid is None:
        print(f"route not found: {route}")
        return
    seen = set()
    order = {"routes_to": 0, "injects": 1}

    def show(nid, depth, label):
        n = nodes[nid]
        print(f"{'  ' * depth}{label}{nid}  [{n['file']}:{n['line_start']}]")
        if n["type"] == "external":
            return
        if nid in seen or depth > max_depth:
            if nid in seen and out[nid]:
                print(f"{'  ' * (depth + 1)}(already expanded)")
            return
        seen.add(nid)
        for e in sorted(out[nid], key=lambda e: (order.get(e["type"], 2), e["line"] or 0)):
            target = nodes[e["target"]]
            if e["type"] not in ("routes_to", "injects", "calls", "uncertain"):
                continue
            if target["type"] == "external" and not LIBRARY_STEP.search(target["id"]):
                continue
            mark = "?? BREAK " if e["type"] == "uncertain" else ""
            show(e["target"], depth + 1, f"{mark}{e['type']} L{e['line']} -> ")

    show(rid, 0, "")


def cmd_files(g, r, repo, root):
    base = os.path.join(repo, root)
    all_py = set()
    for dp, _dns, fns in os.walk(base):
        for f in fns:
            if f.endswith(".py"):
                all_py.add(os.path.relpath(os.path.join(dp, f), repo).replace(os.sep, "/"))
    files = r["files"]
    included = set(files["included"])
    excluded = {d["path"] for d in files["excluded_files"]}
    dirs = [d["path"] + "/" for d in files["excluded_dirs"]]
    under_dirs = {p for p in all_py if any(p.startswith(d) for d in dirs)}
    unaccounted = all_py - included - excluded - under_dirs
    parsed_modules = {x["file"] for x in g["nodes"] if x["type"] == "module"}
    print(f".py files under {root}: {len(all_py)}")
    print(f"  included: {len(included)}  modules with a node: {len(parsed_modules)}")
    print(f"  excluded by dir rule: {len(under_dirs)}  excluded by file rule: {len(excluded)}")
    print(f"  unaccounted: {len(unaccounted)} {sorted(unaccounted)}")
    print(f"  included but no module node (silently skipped): {sorted(included - parsed_modules)}")
    print(f"  parse failures: {json.dumps(files['parse_failures'], indent=1)}")


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
    r = load(os.path.join(os.path.dirname(os.path.abspath(a.graph)), "report.json"))
    if a.cmd == "sample":
        cmd_sample(g, r, a.repo, a.kind, a.n)
    elif a.cmd == "flow":
        cmd_flow(g, a.repo, a.route, a.depth)
    else:
        cmd_files(g, r, a.repo, a.root)


if __name__ == "__main__":
    main()
