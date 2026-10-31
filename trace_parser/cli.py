"""CLI: python -m trace_parser build --repo <path> --root <subfolder> --out out/graph.json"""

from __future__ import annotations

import argparse
import json
import os

from .builder import GraphBuilder


def write_graph(graph: dict, out: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(graph, fh, indent=1, sort_keys=True, ensure_ascii=False)
        fh.write("\n")


def format_stats(graph: dict) -> str:
    s, m = graph["stats"], graph["meta"]
    lines = [
        f"repo            {m['repo']} @ {m['commit']}",
        f"root            {m['root']}",
        f"files           {s['files_included']} included, {s['files_parsed']} parsed, "
        f"{s['parse_failures']} parse failure(s) ({s['parse_failures_unrecovered']} unrecovered)",
    ]
    for pf in m["parse_failures"]:
        lines.append(f"  ! {pf['file']}:{pf['line']} {pf['error']} -> recovered={pf['recovered']} {pf['recovery'] or ''}")
    for d in m["excluded_dirs"]:
        lines.append(f"  excluded dir  {d['path']} ({d['reason']}, {d['py_files']} .py)")
    for d in m["excluded_files"]:
        lines.append(f"  excluded file {d['path']} ({d['reason']})")
    lines.append("nodes           " + ", ".join(f"{k}={v}" for k, v in s["nodes_by_type"].items()))
    lines.append("edges           " + ", ".join(f"{k}={v}" for k, v in s["edges_by_type"].items()))
    lines.append(
        f"call sites      total={s['call_sites_total']} resolved={s['calls_resolved']} "
        f"uncertain={s['calls_uncertain']} external={s['calls_external']}"
    )
    lines.append("  external by evidence: " + ", ".join(f"{k}={v}" for k, v in s["external_by_evidence"].items()))
    lines.append("  uncertain by reason:  " + ", ".join(f"{k}={v}" for k, v in s["uncertain_by_reason"].items()))
    rate = s["call_resolution_rate"]
    lines.append(
        f"resolution      {s['calls_resolved']}/{s['internal_call_sites']} = "
        f"{rate:.1%}" if rate is not None else "resolution      n/a"
    )
    srate = s["strict_call_resolution_rate"]
    if srate is not None:
        lines.append(f"  strict (jedi-only externals): {srate:.1%}")
    lines.append(f"unresolved injections {s['unresolved_injections']}, dangling edges {s['dangling_edges']}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="trace_parser")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="parse a repo and write graph.json")
    b.add_argument("--repo", required=True)
    b.add_argument("--root", default=".", help="subfolder of the repo that is the import root")
    b.add_argument("--out", default="out/graph.json")
    b.add_argument("--strict-parse", action="store_true", help="disable the PEP 758 parse shim")
    args = ap.parse_args(argv)
    graph = GraphBuilder(args.repo, args.root, strict_parse=args.strict_parse).build()
    write_graph(graph, args.out)
    print(format_stats(graph))
    print(f"wrote {args.out}")
    return 0
