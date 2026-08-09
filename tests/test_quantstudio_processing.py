import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quantstudio_processing import analysis, io, platemap as pm  # noqa: E402

HERE = Path(__file__).parent
SYNTH = HERE / "synthetic_384.xlsx"


@pytest.fixture(scope="session")
def synth():
    if not SYNTH.exists():
        subprocess.run([sys.executable, str(HERE / "make_synthetic_384.py")], check=True)
    return SYNTH


# ---------------------------------------------------------------- platemap ---
def test_expand_single():
    assert pm.expand_wells("B2") == ["B2"]


def test_expand_block_is_rectangular():
    assert pm.expand_wells("B2:C3") == ["B2", "B3", "C2", "C3"]


def test_expand_handles_reversed_and_dash():
    assert pm.expand_wells("C3-B2") == pm.expand_wells("B2:C3")


def test_expand_union_dedups():
    assert pm.expand_wells(["B2:B3", "B3, B4"]) == ["B2", "B3", "B4"]


def test_expand_384_row_letters():
    assert pm.expand_wells("P24") == ["P24"]
    assert len(pm.expand_wells("A1:P24")) == 384


def test_expand_rejects_garbage():
    with pytest.raises(ValueError):
        pm.expand_wells("not-a-well")


def test_yaml_rejects_double_assignment(tmp_path):
    p = tmp_path / "m.yaml"
    p.write_text("assay:\n  a: B2:B4\n  b: B4\n")
    with pytest.raises(ValueError, match="twice"):
        pm.from_yaml(p)


def test_annotate_rejects_wells_not_in_export(synth):
    b = io.load(synth)
    design = pd.DataFrame({"well_position": ["Z99"], "assay": ["x"]})
    with pytest.raises(ValueError, match="not present"):
        pm.annotate(b["results"], design)


# ---------------------------------------------------------------------- io ---
def test_reads_despite_long_preamble_and_alias_columns(synth):
    b = io.load(synth)
    res = b["results"]
    # 'Cq' -> ct, 'Detector Name' -> target, 'Tm 1' -> tm1
    for c in ("well", "well_position", "ct", "target", "task", "tm1"):
        assert c in res.columns, c
    assert len(res) == 384


def test_plate_format_detected(synth):
    assert io.load(synth)["plate_format"] == 384


def test_well_position_backfilled_into_amplification(synth):
    amp = io.load(synth)["amplification"]
    assert "well_position" in amp.columns
    assert amp["well_position"].notna().all()


def test_split_well_position():
    r, c = io.split_well_position(pd.Series(["A1", "H12", "P24"]))
    assert list(r) == ["A", "H", "P"]
    assert list(c) == [1, 12, 24]


# ---------------------------------------------------------------- analysis ---
def test_undetermined_becomes_nan_not_40():
    df = pd.DataFrame({"well": [1, 2], "ct": ["Undetermined", 20.0]})
    out = analysis.prepare(df)
    assert out["ct"].isna().iloc[0]
    assert list(out["detected"]) == [False, True]
    assert out["ct"].mean() == 20.0  # not dragged toward 40


def test_qc_flags_ntc_and_near_ntc():
    df = pd.DataFrame({
        "well": [1, 2, 3], "well_position": ["A1", "A2", "A3"],
        "target": ["t", "t", "t"], "task": ["UNKNOWN", "UNKNOWN", "NTC"],
        "ct": [20.0, 33.0, 34.0],
    })
    out = analysis.qc(df, assay_col="target")
    assert out.loc[0, "qc_pass"]
    assert "NTC" in out.loc[1, "qc_flags"]
    assert "NTC amplifies" in out.loc[2, "qc_flags"]


def test_qc_flags_early_ct():
    df = pd.DataFrame({"well": [1], "well_position": ["A1"], "target": ["t"],
                       "task": ["UNKNOWN"], "ct": [6.0]})
    assert "baseline" in analysis.qc(df, assay_col="target").loc[0, "qc_flags"]


def test_qc_raises_on_missing_assay_column():
    df = pd.DataFrame({"well": [1], "ct": [20.0]})
    with pytest.raises(KeyError):
        analysis.qc(df, assay_col="target")


def test_summarize_reports_partial_detection():
    df = pd.DataFrame({
        "well": [1, 2, 3], "target": ["t"] * 3, "sample": ["s"] * 3,
        "ct": [20.0, np.nan, 20.2], "detected": [True, False, True],
    })
    s = analysis.summarize(df, ["target", "sample"])
    assert s.loc[0, "n_detected"] == 2 and s.loc[0, "n_wells"] == 3
    assert s.loc[0, "call"].startswith("partial")
    assert s.loc[0, "ct_mean"] == pytest.approx(20.1)


def test_standard_curve_recovers_known_efficiency():
    q = np.repeat([1e2, 1e3, 1e4, 1e5, 1e6], 3)
    df = pd.DataFrame({
        "target": ["t"] * 15, "quantity": q,
        "ct": 40 - 3.3219 * np.log10(q), "detected": True,
    })
    sc = analysis.standard_curve(df)
    assert sc.loc[0, "efficiency_pct"] == pytest.approx(100, abs=1)
    assert sc.loc[0, "r2"] == pytest.approx(1.0, abs=1e-6)


def test_delta_ct_matches_on_sample():
    s = pd.DataFrame({"target": ["a", "b"], "sample": ["s", "s"],
                      "ct_mean": [25.0, 22.0]})
    d = analysis.delta_ct(s, "target", "sample", "a", "b")
    assert d.loc[0, "dct"] == pytest.approx(3.0)
    assert d.loc[0, "fold_2^-dct"] == pytest.approx(0.125)


# --------------------------------------------------------------------- cli ---
def test_cli_end_to_end(synth, tmp_path):
    r = subprocess.run(
        [sys.executable, "-m", "quantstudio_processing.cli", str(synth), "-o", str(tmp_path),
         "--assay-col", "target", "--group-cols", "target,sample"],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "synthetic_384_processed.xlsx").exists()
    assert (tmp_path / "amplification.png").exists()


# ------------------------------------------------------------------- web ---
@pytest.fixture()
def client(synth):
    from quantstudio_processing import webapp
    webapp.app.config.update(TESTING=True)
    return webapp.app.test_client()


def _upload(client, path):
    with open(path, "rb") as fh:
        r = client.post("/api/load", data={"file": (fh, Path(path).name)},
                        content_type="multipart/form-data")
    return r


def test_web_serves_the_page(client):
    assert b"QuantStudio" in client.get("/").data


def test_web_serves_browser_runtime_sources(client):
    response = client.get("/python/quantstudio_processing/browser.py")
    assert response.status_code == 200
    assert b"class BrowserSession" in response.data
    assert client.get("/python/quantstudio_processing/cli.py").status_code == 404


def test_web_load_reports_plate_and_fields(client, synth):
    r = _upload(client, synth)
    assert r.status_code == 200
    d = r.get_json()
    assert d["plate_format"] == 384
    assert d["n_wells"] == 384
    assert "target" in d["from_file"]


def test_web_rejects_a_non_export(client, tmp_path):
    p = tmp_path / "notes.xlsx"
    pd.DataFrame({"a": [1]}).to_excel(p, index=False)
    r = _upload(client, p)
    assert r.status_code == 400
    assert "Could not read" in r.get_json()["error"]


def test_web_analyze_returns_json_without_nan(client, synth):
    """NaN is legal in Python's json and a syntax error in the browser."""
    sid = _upload(client, synth).get_json()["sid"]
    r = client.post("/api/analyze", json={
        "sid": sid, "fields": {}, "assay_col": "target",
        "group_cols": ["target", "sample"], "skip_plots": True})
    assert r.status_code == 200
    assert b"NaN" not in r.data
    tables = r.get_json()["tables"]
    assert {"per_well", "summary"} <= set(tables)


def test_web_analyze_explains_a_missing_assay_column(client, synth):
    sid = _upload(client, synth).get_json()["sid"]
    r = client.post("/api/analyze", json={"sid": sid, "fields": {},
                                          "assay_col": "nope", "skip_plots": True})
    assert r.status_code == 400
    assert "nope" in r.get_json()["error"]


def test_web_download_needs_an_analysis_first(client, synth):
    sid = _upload(client, synth).get_json()["sid"]
    assert client.get(f"/api/download/{sid}").status_code == 400
    client.post("/api/analyze", json={"sid": sid, "fields": {},
                                      "assay_col": "target", "skip_plots": True})
    r = client.get(f"/api/download/{sid}")
    assert r.status_code == 200
    assert r.data[:2] == b"PK"          # a real xlsx


def test_web_platemap_yaml_round_trips(client):
    fields = {"assay": {**{f"{r}{c}": "aicr" for r in "BCDE" for c in (2, 3, 4)},
                        "F2": "aicr"}}
    r = client.post("/api/platemap-yaml", json={"fields": fields, "name": "t"})
    import yaml
    doc = yaml.safe_load(r.get_json()["yaml"])
    assert sorted(pm.expand_wells(doc["assay"]["aicr"])) == sorted(fields["assay"])


# -------------------------------------------------------------- platemap ---
def test_compress_wells_round_trips():
    for spec in ["B2:E4", "B2:B4, D6:D8", "A1", "A1:P24", "F7"]:
        wells = pm.expand_wells(spec)
        assert sorted(pm.expand_wells(pm.compress_wells(wells))) == sorted(wells)


def test_compress_wells_merges_a_block():
    assert pm.compress_wells(["B2", "B3", "C2", "C3"]) == ["B2:C3"]
