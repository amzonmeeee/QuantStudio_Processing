"""Command line entry point: qpcr-tools <export.xlsx> [options]."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from . import analysis, io, plot, platemap as pm


def build_parser():
    p = argparse.ArgumentParser(
        prog="qsp",
        description="Tidy, QC and plot QuantStudio-family qPCR exports. "
                    "Use `qsp gui` for the browser interface.")
    p.add_argument("export", type=Path, help="QuantStudio .xlsx export")
    p.add_argument("-o", "--outdir", type=Path, default=Path("qpcr_out"))
    p.add_argument("-m", "--platemap", type=Path,
                   help="YAML or CSV design file; defaults to the Sample Setup sheet")
    p.add_argument("--assay-col", default="target",
                   help="column identifying the assay / primer set (default: target)")
    p.add_argument("--group-cols", default=None,
                   help="comma-separated replicate keys "
                        "(default: <assay-col>,sample)")
    p.add_argument("--colour-by", default=None,
                   help="curve colour column (default: sample)")
    p.add_argument("--quantity-col", default="quantity",
                   help="numeric input column for the standard curve")
    p.add_argument("--dct", nargs=2, metavar=("TARGET", "REFERENCE"),
                   help="compute dCt between two assays")
    p.add_argument("--ntc-margin", type=float, default=analysis.DEFAULTS["ntc_margin"])
    p.add_argument("--sd-max", type=float, default=analysis.DEFAULTS["sd_max"])
    p.add_argument("--ct-min", type=float, default=analysis.DEFAULTS["ct_min"])
    p.add_argument("--sc-qc-pass-only", action="store_true",
                   help="fit the standard curve on QC-passing wells only")
    p.add_argument("--no-plots", action="store_true")
    return p


def gui(argv):
    p = argparse.ArgumentParser(prog="qsp gui", description="Open the browser GUI.")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--no-browser", action="store_true")
    a = p.parse_args(argv)
    from .webapp import serve
    serve(host=a.host, port=a.port, open_browser=not a.no_browser)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "gui":
        return gui(argv[1:])
    args = build_parser().parse_args(argv)
    args.outdir.mkdir(parents=True, exist_ok=True)

    bundle = io.load(args.export)
    results, setup = bundle["results"], bundle["setup"]

    design = pm.load_platemap(args.platemap) if args.platemap else None
    wells = pm.annotate(results, design, setup)

    assay = args.assay_col
    if assay not in wells.columns:
        sys.exit(f"error: --assay-col {assay!r} not found. "
                 f"available: {', '.join(sorted(wells.columns))}")

    wells = analysis.qc(wells, assay_col=assay, ntc_margin=args.ntc_margin,
                        sd_max=args.sd_max, ct_min=args.ct_min)

    group_cols = ([c.strip() for c in args.group_cols.split(",")]
                  if args.group_cols else
                  [c for c in (assay, "sample") if c in wells.columns])
    summary = analysis.summarize(wells, group_cols, sd_max=args.sd_max)

    sheets = {"per_well": wells, "summary": summary}
    if args.quantity_col in wells.columns:
        sc = analysis.standard_curve(wells, args.quantity_col, assay,
                                     qc_pass_only=args.sc_qc_pass_only)
        if len(sc):
            sheets["standard_curve"] = sc
    if args.dct:
        sample_col = next((c for c in group_cols if c != assay), None)
        if sample_col:
            sheets["delta_ct"] = analysis.delta_ct(summary, assay, sample_col, *args.dct)

    out_xlsx = args.outdir / f"{args.export.stem}_processed.xlsx"
    with pd.ExcelWriter(out_xlsx, engine="openpyxl") as xw:
        for name, df in sheets.items():
            df.to_excel(xw, sheet_name=name[:31], index=False)

    if not args.no_plots:
        colour_by = args.colour_by or next(
            (c for c in group_cols if c != assay), "well_position")
        thr = (wells.groupby(assay)["threshold"].median().to_dict()
               if "threshold" in wells.columns else None)
        run = bundle["meta"].get("Experiment Name", args.export.stem)
        for kind, key in (("amplification", "amplification"), ("melt", "melt")):
            fig = plot.curves(wells, bundle[key], kind, facet_by=assay,
                              colour_by=colour_by, thresholds=thr, title=str(run))
            if fig:
                fig.savefig(args.outdir / f"{kind}.png", dpi=150)
        fig = plot.plate_heatmap(wells, "ct", title=f"Ct by well ({bundle['plate_format']}-well)")
        if fig:
            fig.savefig(args.outdir / "plate_ct.png", dpi=150)

    fails = int((~wells["qc_pass"]).sum())
    print(f"{len(wells)} wells, plate format: {bundle['plate_format']}")
    print(f"{fails} wells with QC flags")
    print(f"wrote {out_xlsx}")
    for f in sorted(args.outdir.glob("*.png")):
        print(f"wrote {f}")


if __name__ == "__main__":
    main()
