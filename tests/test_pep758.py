from backend.trace.parser import GraphBuilder

SOURCE = '''\
def risky():
    raise ValueError


def guarded():
    try:
        risky()
    except ValueError, TypeError:
        return None
'''


def test_unparenthesized_except_parses_natively(tmp_path):
    (tmp_path / "pep758.py").write_text(SOURCE)
    graph, report = GraphBuilder(str(tmp_path), ".").build()
    assert report["files"]["parse_failures"] == []
    calls = {(e["source"], e["target"]) for e in graph["edges"] if e["type"] == "calls"}
    assert calls == {("pep758:guarded", "pep758:risky")}
