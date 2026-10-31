"""CLI: python -m backend.trace.parser build --repo <path> --root <subfolder> --out out/graph.json

Writes the Graph contract to --out and the parser's report to report.json in the same folder.
"""

from __future__ import annotations

import argparse
import json
import os

from .builder import GraphBuilder


def write_json(data: dict, out: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, sort_keys=True, ensure_ascii=False)
        fh.write("\n")


def report_path(out: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(out)), "report.json")


def format_stats(graph: dict, report: dict) -> str:
    stats, files, calls, injections = graph["stats"], report["files"], report["calls"], report["injections"]
    lines = [
        f"repo            {report['repo']} @ {report['commit_sha']}",
        f"root            {report['root']}",
        f"files           {len(files['included'])} included, {files['parsed']} parsed, "
        f"{len(files['parse_failures'])} parse failure(s)",
    ]
    for failure in files["parse_failures"]:
        lines.append(f"  ! {failure['file']}:{failure['line']} {failure['error']}")
    for entry in files["excluded_dirs"]:
        lines.append(f"  excluded dir  {entry['path']} ({entry['reason']}, {entry['py_files']} .py)")
    for entry in files["excluded_files"]:
        lines.append(f"  excluded file {entry['path']} ({entry['reason']})")
    lines.append("nodes           " + ", ".join(f"{k}={v}" for k, v in stats["nodes_by_type"].items()))
    lines.append("edges           " + ", ".join(f"{k}={v}" for k, v in stats["edges_by_type"].items()))
    lines.append(
        f"call sites      total={calls['total']} resolved={calls['resolved']} "
        f"uncertain={calls['uncertain']} external={calls['external']}"
    )
    lines.append("  external by evidence: " + ", ".join(f"{k}={v}" for k, v in calls["external_by_evidence"].items()))
    lines.append("  uncertain by reason:  " + ", ".join(f"{k}={v}" for k, v in calls["uncertain_by_reason"].items()))
    rate, strict = calls["resolution_rate"], calls["strict_resolution_rate"]
    lines.append(f"resolution      {calls['resolved']}/{calls['internal']}" + (f" = {rate:.1%}" if rate is not None else ""))
    if strict is not None:
        lines.append(f"  strict (jedi-only externals): {strict:.1%}")
    lines.append(
        f"injections      total={injections['total']} resolved={injections['resolved']} "
        f"external={injections['external']} uncertain={injections['uncertain']}"
    )
    lines.append(f"dangling edges  {report['dangling_edges']}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="backend.trace.parser")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="parse a repo and write graph.json, plus report.json beside it")
    b.add_argument("--repo", required=True)
    b.add_argument("--root", default=".", help="subfolder of the repo that is the import root")
    b.add_argument("--out", default="out/graph.json")
    args = ap.parse_args(argv)
    graph, report = GraphBuilder(args.repo, args.root).build()
    write_json(graph, args.out)
    write_json(report, report_path(args.out))
    print(format_stats(graph, report))
    print(f"wrote {args.out} and {report_path(args.out)}")
    return 0
