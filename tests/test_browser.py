"""Focused coverage for the framework-independent browser bridge."""
from __future__ import annotations

import io
import json
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quantstudio_processing import io as qsp_io  # noqa: E402
from quantstudio_processing import platemap as pm  # noqa: E402
from quantstudio_processing import webcore  # noqa: E402
from quantstudio_processing.browser import BrowserSession  # noqa: E402


HERE = Path(__file__).parent
SYNTH = HERE / "synthetic_384.xlsx"


@pytest.fixture(scope="session")
def synth_workbook():
    if not SYNTH.exists():
        subprocess.run(
            [sys.executable, str(HERE / "make_synthetic_384.py")], check=True
        )
    return SYNTH


def _decode_envelope(raw):
    """Decode the exact text JavaScript receives and enforce strict JSON."""
    assert "NaN" not in raw
    assert "Infinity" not in raw
    return json.loads(raw, parse_constant=lambda value: pytest.fail(value))


def _assert_true_vector_svg(data):
    root = ET.fromstring(data)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    lowered = data.lower()
    assert b"<image" not in lowered
    assert b"data:image" not in lowered
    vector_tags = {"path", "rect", "polygon", "polyline", "line", "circle"}
    assert any(element.tag.rsplit("}", 1)[-1] in vector_tags for element in root.iter())


def test_static_frontend_uses_the_local_worker_instead_of_http_apis():
    web = Path(__file__).resolve().parents[1] / "quantstudio_processing" / "web"
    app_source = (web / "app.js").read_text()
    app_css = (web / "app.css").read_text()
    index_source = (web / "index.html").read_text()
    worker_source = (web / "pyodide-worker.js").read_text()

    assert "/api/" not in app_source
    assert "fetch(" not in app_source
    assert "new Worker" in (web / "pyodide-client.js").read_text()
    assert "curvesZip()" in (web / "pyodide-client.js").read_text()
    assert "curvesSvgZip()" in (web / "pyodide-client.js").read_text()
    assert "plotSvg(name)" in (web / "pyodide-client.js").read_text()
    assert "browserApi.plots_zip_bytes()" in worker_source
    assert "browserApi.svg_plots_zip_bytes()" in worker_source
    assert "browserApi.plot_bytes(name)" in worker_source
    assert "browserApi.plot_svg_bytes(payload.name)" in worker_source
    assert "Download all PNGs" in app_source
    assert "Download all SVGs" in app_source
    assert "Download PNG" in app_source
    assert "Download SVG" in app_source
    assert "image/svg+xml;charset=utf-8" in app_source
    assert "plot-actions" in app_source
    assert "el('figure'" in app_source
    assert "prompt(" not in app_source
    assert "Select another plate" in index_source
    assert "Leave this plate?" in index_source
    assert 'id="leaveGuard"' in index_source
    assert "beforeunload" in app_source
    assert "pagehide" in app_source
    assert "dblclick" in app_source
    assert "itemAction('remove'" in app_source
    assert "96 / 384 wells" in index_source
    assert "plate-notch" not in index_source
    assert "plateIllustrationTitle" not in index_source
    assert "overflow-wrap: anywhere" in app_css
    assert "max-width: 29ch" not in app_css
    assert "Local analyzer ready. Your workbook never leaves this browser." not in worker_source
    assert "Starting analyzer…" in index_source
    assert "runtimeStatusLabel" in app_source
    assert "data-scroll-lens" in index_source
    assert "scroll-cue" in app_css
    assert "progressive-blur" not in app_css
    assert "syncScrollLens" in app_source
    assert 'id="optCurveBg"' in index_source
    assert "curve_background: $('#optCurveBg').checked" in app_source
    assert "table-sticky-head" in app_source
    assert "table-sticky-head" in app_css
    assert "overflow-y: clip" in app_css
    assert "max-height: min(68vh" not in app_css
    assert ".result-body { min-height: 180px; overflow: visible;" in app_css
    for module in (
        "analysis.py",
        "browser.py",
        "io.py",
        "platemap.py",
        "plot.py",
        "webcore.py",
    ):
        assert repr(module) in worker_source


def test_records_sanitizes_dataframe_scalars_for_strict_json():
    frame = pd.DataFrame(
        {
            "integer": pd.Series([np.int64(7)], dtype=object),
            "boolean": pd.Series([np.bool_(True)], dtype=object),
            "nan": [np.nan],
            "positive_infinity": [np.inf],
            "negative_infinity": [-np.inf],
            "missing": [pd.NA],
        }
    )

    result = webcore.records(frame)

    assert result["columns"] == list(frame.columns)
    assert result["rows"] == [[7, True, None, None, None, None]]
    json.dumps(result, allow_nan=False)


def test_io_loads_bytesio_with_the_same_results_as_a_path(synth_workbook):
    from_path = qsp_io.load(synth_workbook)
    source = io.BytesIO(synth_workbook.read_bytes())

    from_memory = qsp_io.load(source)

    assert not source.closed
    assert from_memory["plate_format"] == from_path["plate_format"] == 384
    assert from_memory["meta"] == from_path["meta"]
    for key in ("results", "amplification"):
        pd.testing.assert_frame_equal(from_memory[key], from_path[key])


def test_browser_session_analyzes_and_exports_a_workbook(synth_workbook):
    session = BrowserSession()
    loaded = _decode_envelope(
        session.load_bytes(synth_workbook.read_bytes(), "browser input.xlsx")
    )

    assert loaded["ok"] is True
    assert loaded["data"]["filename"] == "browser input.xlsx"
    assert loaded["data"]["plate_format"] == 384
    assert loaded["data"]["n_wells"] == 384

    analyzed_raw = session.analyze_json(
        json.dumps(
            {
                "fields": {},
                "assay_col": "target",
                "group_cols": ["target", "sample"],
                "quantity_col": None,
                "skip_plots": True,
            }
        )
    )
    analyzed = _decode_envelope(analyzed_raw)

    assert analyzed["ok"] is True
    assert {"per_well", "summary"} <= set(analyzed["data"]["tables"])
    assert "standard_curve" not in analyzed["data"]["tables"]
    assert analyzed["data"]["plots"] == {}

    workbook = session.workbook_bytes()
    assert workbook[:2] == b"PK"
    with pd.ExcelFile(io.BytesIO(workbook)) as book:
        assert {"per_well", "summary"} <= set(book.sheet_names)
        per_well = pd.read_excel(book, sheet_name="per_well")
    assert len(per_well) == 384

    # A failed rerun must invalidate the previously generated download.
    failed = _decode_envelope(
        session.analyze_json(
            json.dumps({"fields": {}, "assay_col": "not_on_the_plate"})
        )
    )
    assert failed["ok"] is False
    assert "not_on_the_plate" in failed["error"]
    assert session.tables is None
    assert session.svg_plots == {}
    with pytest.raises(webcore.UserError, match="before downloading"):
        session.workbook_bytes()


def test_browser_session_errors_reset_state_and_plots():
    session = BrowserSession()

    no_workbook = _decode_envelope(session.analyze_json("{}"))
    assert no_workbook == {
        "ok": False,
        "error": "Load a workbook before running the analysis.",
    }
    with pytest.raises(webcore.UserError, match="before downloading"):
        session.workbook_bytes()

    session.bundle = {"stale": True}
    session.tables = {"stale": pd.DataFrame()}
    session.plots = {"plate": b"png", "melt": b"melt"}
    session.svg_plots = {"plate": b"<svg>plate</svg>"}
    session.svg_plots_archive = b"stale svg zip"
    session.filename = "stale.xlsx"

    assert session.plot_svg_bytes("plate") == b"<svg>plate</svg>"
    assert session.plot_svg_bytes("plate") == b"<svg>plate</svg>"
    with pytest.raises(webcore.UserError, match="SVG plot"):
        session.plot_svg_bytes("melt")
    assert session.plot_bytes("plate") == b"png"
    assert session.plot_bytes("plate") == b"png"
    assert session.take_plot("plate") == b"png"
    with pytest.raises(webcore.UserError, match="no longer available"):
        session.take_plot("plate")

    bad_load = _decode_envelope(session.load_bytes(b"not an xlsx", "broken.xlsx"))
    assert bad_load["ok"] is False
    assert "Could not read this export" in bad_load["error"]
    assert session.bundle is None
    assert session.tables is None
    assert session.plots == {}
    assert session.svg_plots == {}
    assert session.svg_plots_archive is None
    assert session.filename is None

    session.reset()
    assert session.bundle is None
    assert session.tables is None
    assert session.plots == {}
    assert session.svg_plots == {}
    assert session.svg_plots_archive is None
    assert session.filename is None


def test_browser_exports_true_vector_svg_and_keeps_it_after_png_zip(
    synth_workbook,
):
    session = BrowserSession()
    loaded = _decode_envelope(
        session.load_bytes(synth_workbook.read_bytes(), "synthetic_384.xlsx")
    )
    assert loaded["ok"] is True

    analyzed = _decode_envelope(
        session.analyze_json(
            json.dumps(
                {
                    "fields": {},
                    "assay_col": "target",
                    "group_cols": ["target", "sample"],
                    "quantity_col": None,
                }
            )
        )
    )
    assert analyzed["ok"] is True
    assert set(analyzed["data"]["plots"]) == {"amplification", "plate"}

    svg_exports = {}
    for name in analyzed["data"]["plots"]:
        png = session.plot_bytes(name)
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        svg = session.plot_svg_bytes(name)
        assert session.plot_svg_bytes(name) is svg
        _assert_true_vector_svg(svg)
        svg_exports[name] = svg

    archive_bytes = session.plots_zip_bytes()
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        assert archive.namelist() == [
            "synthetic_384_amplification.png",
            "synthetic_384_plate_ct.png",
        ]
        assert all(
            archive.read(name).startswith(b"\x89PNG")
            for name in archive.namelist()
        )

    assert session.plots == {}
    for name, svg in svg_exports.items():
        assert session.plot_svg_bytes(name) is svg

    svg_archive = session.svg_plots_zip_bytes()
    assert session.svg_plots_zip_bytes() is svg_archive
    with zipfile.ZipFile(io.BytesIO(svg_archive)) as archive:
        assert archive.namelist() == [
            "synthetic_384_amplification.svg",
            "synthetic_384_plate_ct.svg",
        ]
        for name, plot_name in zip(
            archive.namelist(), ["amplification", "plate"]
        ):
            assert archive.read(name) == svg_exports[plot_name]

    for name, svg in svg_exports.items():
        assert session.plot_svg_bytes(name) is svg


def test_browser_packages_all_curve_images_into_a_reusable_zip():
    session = BrowserSession()
    session.filename = 'Δ plate?: export.xlsx'
    session.plots = {
        "amplification": b"\x89PNG\r\namplification",
        "melt": b"\x89PNG\r\nmelt",
        "plate": b"\x89PNG\r\nplate",
    }

    archive_bytes = session.plots_zip_bytes()
    assert archive_bytes[:2] == b"PK"
    assert session.plots == {}
    assert session.plots_zip_bytes() is archive_bytes

    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        assert archive.namelist() == [
            "Δ plate_ export_amplification.png",
            "Δ plate_ export_melt.png",
            "Δ plate_ export_plate_ct.png",
        ]
        assert archive.read("Δ plate_ export_melt.png") == b"\x89PNG\r\nmelt"

    empty = BrowserSession()
    with pytest.raises(webcore.UserError, match="analysis with plots"):
        empty.plots_zip_bytes()
    with pytest.raises(webcore.UserError, match="analysis with plots"):
        empty.svg_plots_zip_bytes()


def test_browser_platemap_yaml_preserves_unicode_and_round_trips():
    session = BrowserSession()
    fields = {
        "assay": {"B2": "äicr", "B3": "äicr", "C2": "äicr", "C3": "äicr"},
        "sample": {"B2": "δ-sample", "B3": "δ-sample", "C2": "", "C3": None},
    }

    raw = session.platemap_yaml_json(
        json.dumps({"fields": fields, "name": "Δ plate"}, ensure_ascii=False)
    )
    response = _decode_envelope(raw)
    document = yaml.safe_load(response["data"]["yaml"])

    assert response["ok"] is True
    assert document["name"] == "Δ plate"
    assert sorted(pm.expand_wells(document["assay"]["äicr"])) == [
        "B2",
        "B3",
        "C2",
        "C3",
    ]
    assert sorted(pm.expand_wells(document["sample"]["δ-sample"])) == ["B2", "B3"]
    assert webcore.processed_filename("run.v2.xlsx") == "run.v2_processed.xlsx"
