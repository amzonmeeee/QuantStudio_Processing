"""Framework-independent operations shared by Flask and the browser runtime.

The browser build runs these functions inside Pyodide.  Keeping the workbook
parsing, QC, plotting and export orchestration here means the web UI is only a
transport: it never becomes a second implementation of the analysis.
"""
from __future__ import annotations

import io as _io
import math
from numbers import Integral, Real
from pathlib import Path

import numpy as np
import pandas as pd

from . import analysis, io, platemap as pm


class UserError(ValueError):
    """An input problem that is safe and useful to show in the UI."""


def load_export(source, filename: str) -> tuple[dict, dict]:
    """Parse one export and return its internal bundle plus a JSON-safe view."""
    try:
        bundle = io.load(source)
    except Exception as exc:
        raise UserError(f"Could not read this export: {exc}") from exc

    res = bundle["results"]
    setup = bundle["setup"]
    required = {"well", "well_position", "ct"}
    missing = sorted(required - set(res.columns))
    if missing:
        raise UserError(
            "The Results sheet is missing required column"
            f"{'s' if len(missing) != 1 else ''}: {', '.join(missing)}."
        )
    if setup is not None and "biogroup" in setup.columns and "biogroup" not in res.columns:
        res = res.merge(setup[["well", "biogroup"]], on="well", how="left")
        bundle["results"] = res

    from_file = {}
    for col in ("target", "sample", "task", "biogroup"):
        if col in res.columns:
            vals = {
                str(wp): (None if pd.isna(v) else str(v))
                for wp, v in zip(res["well_position"], res[col])
            }
            if any(v is not None for v in vals.values()):
                from_file[col] = vals

    ct = pd.to_numeric(res.get("ct"), errors="coerce")
    plate_format = bundle["plate_format"] or 96
    payload = {
        "filename": filename,
        "plate_format": plate_format,
        "experiment": str(bundle["meta"].get("Experiment Name", filename)),
        "instrument": str(bundle["meta"].get("Instrument Type", "")),
        "n_wells": int(len(res)),
        "wells": [
            {
                "pos": str(wp),
                "ct": (
                    None
                    if pd.isna(c) or not math.isfinite(float(c))
                    else round(float(c), 2)
                ),
            }
            for wp, c in zip(res["well_position"], ct)
        ],
        "from_file": from_file,
        "has_amplification": bundle["amplification"] is not None,
        "has_melt": bundle["melt"] is not None,
    }
    return bundle, payload


def _platemap_frame(fields: dict) -> pd.DataFrame:
    """Convert ``{field: {well: value}}`` into a tidy platemap frame."""
    if not fields:
        return pd.DataFrame(columns=["well_position"])
    frames = []
    for field, mapping in fields.items():
        if field == "well_position":
            raise UserError("“well_position” is reserved for the workbook well address.")
        if not isinstance(mapping, dict):
            raise UserError(f"Platemap field “{field}” must map wells to values.")
        s = pd.Series(
            {k: v for k, v in mapping.items() if v not in (None, "")},
            name=field,
        )
        if len(s):
            frames.append(s)
    if not frames:
        return pd.DataFrame(columns=["well_position"])
    out = pd.concat(frames, axis=1)
    out.index.name = "well_position"
    return out.reset_index()


def _fig_exports(fig) -> tuple[bytes, bytes] | None:
    """Encode one live Figure as matching PNG and SVG files, then close it."""
    if fig is None:
        return None
    png = _io.BytesIO()
    svg = _io.BytesIO()
    try:
        fig.savefig(png, format="png", dpi=140, bbox_inches="tight")
        fig.savefig(svg, format="svg", bbox_inches="tight")
        return png.getvalue(), svg.getvalue()
    finally:
        import matplotlib.pyplot as plt

        plt.close(fig)


def _json_value(value):
    """Unwrap dataframe scalars into strict-JSON-compatible values."""
    if value is None:
        return None
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (np.integer, Integral)):
        return int(value)
    if isinstance(value, (np.floating, Real)):
        number = float(value)
        return number if math.isfinite(number) else None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


def records(df: pd.DataFrame) -> dict:
    """Represent a dataframe as strict JSON without leaking NaN/Infinity."""
    return {
        "columns": [str(c) for c in df.columns],
        "rows": [[_json_value(v) for v in row]
                 for row in df.itertuples(index=False, name=None)],
    }


def _nonnegative_option(options: dict, key: str, default: float) -> float:
    raw = options.get(key, default)
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise UserError(f"{key.replace('_', ' ')} must be a number.") from exc
    if not math.isfinite(value) or value < 0:
        raise UserError(f"{key.replace('_', ' ')} must be a non-negative number.")
    return value


def analyze_bundle(
    bundle: dict, body: dict
) -> tuple[dict, dict[str, bytes], dict[str, bytes], dict]:
    """Run analysis and return tables, matching PNG/SVG plots and UI payload."""
    design = _platemap_frame(body.get("fields") or {})
    assay = body.get("assay_col") or "target"
    group_cols = [c for c in (body.get("group_cols") or []) if c]

    try:
        wells = pm.annotate(
            bundle["results"],
            design if len(design) else None,
            bundle["setup"],
        )
    except ValueError as exc:
        raise UserError(str(exc)) from exc

    if assay not in wells.columns:
        raise UserError(
            f"No column called “{assay}”. Assign it on the plate first, "
            f"or pick a different assay field."
        )
    if not group_cols:
        group_cols = [c for c in (assay, "sample") if c in wells.columns]

    missing = [c for c in group_cols if c not in wells.columns]
    if missing:
        raise UserError(f"Replicate key not on the plate: {', '.join(missing)}")

    options = body.get("options") or {}
    ntc_margin = _nonnegative_option(
        options, "ntc_margin", analysis.DEFAULTS["ntc_margin"]
    )
    sd_max = _nonnegative_option(options, "sd_max", analysis.DEFAULTS["sd_max"])
    ct_min = _nonnegative_option(options, "ct_min", analysis.DEFAULTS["ct_min"])

    wells = analysis.qc(
        wells,
        assay_col=assay,
        ntc_margin=ntc_margin,
        sd_max=sd_max,
        ct_min=ct_min,
    )
    summary = analysis.summarize(wells, group_cols, sd_max=sd_max)

    tables = {"per_well": wells, "summary": summary}

    # Missing means the historical default; explicit null means the user chose
    # "(none)" and must not silently run a standard curve from an export column.
    qcol = body.get("quantity_col", "quantity")
    if qcol and qcol in wells.columns:
        wells[qcol] = pd.to_numeric(wells[qcol], errors="coerce")
        sc = analysis.standard_curve(
            wells,
            qcol,
            assay,
            qc_pass_only=bool(options.get("sc_qc_pass_only")),
        )
        if len(sc):
            tables["standard_curve"] = sc

    dct = body.get("dct")
    sample_col = next((c for c in group_cols if c != assay), None)
    if dct and len(dct) == 2 and all(dct) and sample_col:
        try:
            tables["delta_ct"] = analysis.delta_ct(
                summary, assay, sample_col, *dct
            )
        except KeyError as exc:
            raise UserError(str(exc).strip("'")) from exc

    plot_bytes: dict[str, bytes] = {}
    svg_plot_bytes: dict[str, bytes] = {}
    if not body.get("skip_plots"):
        # Lazy import keeps Matplotlib out of the initial workbook-load path in
        # Pyodide.  The worker loads the package immediately before this call.
        from . import plot

        colour = body.get("colour_by") or sample_col or "well_position"
        thresholds = (
            wells.groupby(assay)["threshold"].median().to_dict()
            if "threshold" in wells.columns
            else None
        )
        title = str(bundle["meta"].get("Experiment Name", ""))
        for kind, key in (("amplification", "amplification"), ("melt", "melt")):
            if bundle[key] is not None:
                exports = _fig_exports(
                    plot.curves(
                        wells,
                        bundle[key],
                        kind,
                        facet_by=assay,
                        colour_by=colour,
                        thresholds=thresholds,
                        title=title,
                    )
                )
                if exports:
                    plot_bytes[kind], svg_plot_bytes[kind] = exports
        exports = _fig_exports(plot.plate_heatmap(wells, "ct"))
        if exports:
            plot_bytes["plate"], svg_plot_bytes["plate"] = exports

    flagged = wells[~wells["qc_pass"]]
    payload = {
        "tables": {name: records(df) for name, df in tables.items()},
        # Transport layers replace these placeholders with data: or blob: URLs.
        "plots": {name: None for name in plot_bytes},
        "n_flagged": int(len(flagged)),
        "n_wells": int(len(wells)),
    }
    return tables, plot_bytes, svg_plot_bytes, payload


def workbook_bytes(tables: dict[str, pd.DataFrame]) -> bytes:
    buf = _io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        for name, df in tables.items():
            df.to_excel(writer, sheet_name=name[:31], index=False)
    return buf.getvalue()


def platemap_yaml_text(fields: dict, name: str | None = None) -> str:
    import yaml

    doc = {"name": name or "untitled plate"}
    for field, mapping in fields.items():
        by_value: dict[str, list[str]] = {}
        for well, value in mapping.items():
            if value in (None, ""):
                continue
            by_value.setdefault(str(value), []).append(well)
        if by_value:
            doc[field] = {key: pm.compress_wells(value) for key, value in by_value.items()}
    return yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=100)


def processed_filename(filename: str) -> str:
    return f"{Path(filename).stem}_processed.xlsx"
