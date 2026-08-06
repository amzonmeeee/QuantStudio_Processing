"""Local web GUI.

A thin Flask layer over the same functions the CLI uses, so the browser never
becomes a second implementation of the analysis. It binds to localhost and
holds one session per uploaded file in memory; this is a single-user desktop
tool, not a server.
"""
from __future__ import annotations

import base64
import io as _io
import math
import secrets
import tempfile
import threading
import webbrowser
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request, send_file, send_from_directory

from . import analysis, io, plot, platemap as pm

WEB = Path(__file__).parent / "web"
SESSIONS: dict[str, dict] = {}

app = Flask(__name__, static_folder=None)


# ----------------------------------------------------------------- serving --
@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:name>")
def asset(name):
    return send_from_directory(WEB, name)


# -------------------------------------------------------------------- load --
@app.post("/api/load")
def load():
    f = request.files.get("file")
    if f is None:
        return jsonify(error="No file in the request."), 400

    tmp = Path(tempfile.mkdtemp()) / f.filename
    f.save(tmp)
    try:
        bundle = io.load(tmp)
    except Exception as exc:
        return jsonify(error=f"Could not read this export: {exc}"), 400

    res = bundle["results"]
    setup = bundle["setup"]
    if setup is not None and "biogroup" in setup.columns and "biogroup" not in res.columns:
        res = res.merge(setup[["well", "biogroup"]], on="well", how="left")
        bundle["results"] = res

    sid = secrets.token_urlsafe(12)
    SESSIONS[sid] = {"bundle": bundle, "path": tmp}

    # fields the export itself offers, so the GUI can pre-fill the plate
    from_file = {}
    for col in ("target", "sample", "task", "biogroup"):
        if col in res.columns:
            vals = {wp: (None if pd.isna(v) else str(v))
                    for wp, v in zip(res["well_position"], res[col])}
            if any(v is not None for v in vals.values()):
                from_file[col] = vals

    ct = pd.to_numeric(res.get("ct"), errors="coerce")
    return jsonify(
        sid=sid,
        filename=f.filename,
        plate_format=bundle["plate_format"] or 96,
        experiment=str(bundle["meta"].get("Experiment Name", f.filename)),
        instrument=str(bundle["meta"].get("Instrument Type", "")),
        n_wells=int(len(res)),
        wells=[{"pos": wp, "ct": None if pd.isna(c) else round(float(c), 2)}
               for wp, c in zip(res["well_position"], ct)],
        from_file=from_file,
        has_amplification=bundle["amplification"] is not None,
        has_melt=bundle["melt"] is not None,
    )


# ----------------------------------------------------------------- analyse --
def _platemap_frame(fields: dict) -> pd.DataFrame:
    """{field: {well: value}} -> tidy platemap frame."""
    if not fields:
        return pd.DataFrame(columns=["well_position"])
    frames = []
    for field, mapping in fields.items():
        s = pd.Series({k: v for k, v in mapping.items() if v not in (None, "")},
                      name=field)
        if len(s):
            frames.append(s)
    if not frames:
        return pd.DataFrame(columns=["well_position"])
    out = pd.concat(frames, axis=1)
    out.index.name = "well_position"
    return out.reset_index()


def _fig_png(fig) -> str | None:
    if fig is None:
        return None
    buf = _io.BytesIO()
    fig.savefig(buf, format="png", dpi=140, bbox_inches="tight")
    import matplotlib.pyplot as plt
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _records(df: pd.DataFrame) -> dict:
    """Tables as plain JSON.

    NaN has to become null here: Python's json module emits a bare NaN, which
    is valid for Python and a syntax error for the browser's JSON.parse. numpy
    scalars are unwrapped for the same reason.
    """
    rows = []
    for row in df.itertuples(index=False, name=None):
        out = []
        for v in row:
            if v is None or (isinstance(v, float) and math.isnan(v)):
                out.append(None)
            elif isinstance(v, (np.bool_, bool)):
                out.append(bool(v))
            elif isinstance(v, np.integer):
                out.append(int(v))
            elif isinstance(v, (np.floating, float)):
                out.append(None if math.isnan(float(v)) else float(v))
            elif pd.isna(v):
                out.append(None)
            else:
                out.append(str(v))
        rows.append(out)
    return {"columns": [str(c) for c in df.columns], "rows": rows}


@app.post("/api/analyze")
def analyze():
    body = request.get_json(force=True)
    sess = SESSIONS.get(body.get("sid"))
    if sess is None:
        return jsonify(error="This file is no longer loaded. Load it again."), 400

    bundle = sess["bundle"]
    design = _platemap_frame(body.get("fields") or {})
    assay = body.get("assay_col") or "target"
    group_cols = [c for c in (body.get("group_cols") or []) if c]

    try:
        wells = pm.annotate(bundle["results"], design if len(design) else None,
                            bundle["setup"])
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    if assay not in wells.columns:
        return jsonify(
            error=f"No column called “{assay}”. Assign it on the plate first, "
                  f"or pick a different assay field."), 400
    if not group_cols:
        group_cols = [c for c in (assay, "sample") if c in wells.columns]

    missing = [c for c in group_cols if c not in wells.columns]
    if missing:
        return jsonify(error=f"Replicate key not on the plate: {', '.join(missing)}"), 400

    opts = body.get("options") or {}
    wells = analysis.qc(
        wells, assay_col=assay,
        ntc_margin=float(opts.get("ntc_margin", analysis.DEFAULTS["ntc_margin"])),
        sd_max=float(opts.get("sd_max", analysis.DEFAULTS["sd_max"])),
        ct_min=float(opts.get("ct_min", analysis.DEFAULTS["ct_min"])),
    )
    summary = analysis.summarize(wells, group_cols,
                                 sd_max=float(opts.get("sd_max",
                                                       analysis.DEFAULTS["sd_max"])))

    out = {"per_well": wells, "summary": summary}

    qcol = body.get("quantity_col") or "quantity"
    if qcol in wells.columns:
        wells[qcol] = pd.to_numeric(wells[qcol], errors="coerce")
        sc = analysis.standard_curve(wells, qcol, assay,
                                     qc_pass_only=bool(opts.get("sc_qc_pass_only")))
        if len(sc):
            out["standard_curve"] = sc

    dct = body.get("dct")
    sample_col = next((c for c in group_cols if c != assay), None)
    if dct and len(dct) == 2 and all(dct) and sample_col:
        try:
            out["delta_ct"] = analysis.delta_ct(summary, assay, sample_col, *dct)
        except KeyError as exc:
            return jsonify(error=str(exc).strip("'")), 400

    sess["tables"] = out
    sess["assay"] = assay

    plots = {}
    if not body.get("skip_plots"):
        colour = body.get("colour_by") or sample_col or "well_position"
        thr = (wells.groupby(assay)["threshold"].median().to_dict()
               if "threshold" in wells.columns else None)
        title = str(bundle["meta"].get("Experiment Name", ""))
        for kind, key in (("amplification", "amplification"), ("melt", "melt")):
            if bundle[key] is not None:
                plots[kind] = _fig_png(plot.curves(
                    wells, bundle[key], kind, facet_by=assay,
                    colour_by=colour, thresholds=thr, title=title))
        plots["plate"] = _fig_png(plot.plate_heatmap(wells, "ct"))

    flagged = wells[~wells["qc_pass"]]
    return jsonify(
        tables={k: _records(v) for k, v in out.items()},
        plots={k: v for k, v in plots.items() if v},
        n_flagged=int(len(flagged)),
        n_wells=int(len(wells)),
    )


@app.get("/api/download/<sid>")
def download(sid):
    sess = SESSIONS.get(sid)
    if sess is None or "tables" not in sess:
        return jsonify(error="Nothing to download yet. Run the analysis first."), 400
    buf = _io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for name, df in sess["tables"].items():
            df.to_excel(xw, sheet_name=name[:31], index=False)
    buf.seek(0)
    stem = Path(sess["path"]).stem
    return send_file(buf, as_attachment=True, download_name=f"{stem}_processed.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument."
                              "spreadsheetml.sheet")


@app.post("/api/platemap-yaml")
def platemap_yaml():
    """Turn the painted plate back into the YAML the CLI reads."""
    import yaml

    body = request.get_json(force=True)
    fields = body.get("fields") or {}
    doc = {"name": body.get("name") or "untitled plate"}
    for field, mapping in fields.items():
        byvalue: dict[str, list[str]] = {}
        for well, value in mapping.items():
            if value in (None, ""):
                continue
            byvalue.setdefault(str(value), []).append(well)
        if byvalue:
            doc[field] = {k: pm.compress_wells(v) for k, v in byvalue.items()}
    text = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=100)
    return jsonify(yaml=text)


def serve(host="127.0.0.1", port=8765, open_browser=True):
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    print(f"QuantStudio_Processing GUI on http://{host}:{port}  (ctrl-c to stop)")
    app.run(host=host, port=port, debug=False)
