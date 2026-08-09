"""Plots. Facets and colours are chosen by column name, never by well address."""
from __future__ import annotations

import math

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def _facets(wells, facet_by):
    if facet_by is None or facet_by not in wells.columns:
        return [(None, wells)]
    return list(wells.groupby(facet_by, dropna=False))


def _colour_map(values):
    vals = [v for v in pd.unique(pd.Series(values)) if pd.notna(v)]
    try:
        vals = sorted(vals)
    except TypeError:
        pass
    cmap = plt.get_cmap("tab10" if len(vals) <= 10 else "tab20")
    return {v: cmap(i % cmap.N) for i, v in enumerate(vals)}


def _is_ntc(row):
    return str(row.get("task", "")).upper() == "NTC"


def _dedup_legend(ax, **kw):
    h, l = ax.get_legend_handles_labels()
    seen = dict(zip(l, h))
    if not seen:
        return
    order = sorted(seen, key=lambda s: (s.startswith("NTC"), str(s)))
    ax.legend([seen[k] for k in order], order, **kw)


def curves(wells: pd.DataFrame, data: pd.DataFrame, kind: str,
           facet_by: str = "target", colour_by: str = "sample",
           logy: bool | None = None, ncols: int = 2, ax_width=6.5, ax_height=4.2,
           thresholds: dict | None = None, title: str | None = None):
    """Amplification or melt curves, one panel per `facet_by` level.

    kind: 'amplification' -> delta_rn vs cycle; 'melt' -> derivative vs temperature.
    """
    if kind == "amplification":
        xcol, ycol, xlabel, ylabel = "cycle", "delta_rn", "Cycle", r"$\Delta$Rn"
        logy = True if logy is None else logy
    elif kind == "melt":
        xcol, ycol, xlabel, ylabel = "temperature", "derivative", "Temperature (°C)", "-dF/dT"
        logy = False if logy is None else logy
    else:
        raise ValueError("kind must be 'amplification' or 'melt'")
    if data is None or xcol not in data.columns or ycol not in data.columns:
        return None

    meta = wells.set_index("well_position")
    colours = _colour_map(wells[colour_by]) if colour_by in wells.columns else {}
    panels = _facets(wells, facet_by)
    nrows = math.ceil(len(panels) / ncols)
    ncols_eff = min(ncols, len(panels))
    fig, axes = plt.subplots(nrows, ncols_eff,
                             figsize=(ax_width * ncols_eff, ax_height * nrows),
                             squeeze=False)
    flat = axes.ravel()

    for ax, (name, sub) in zip(flat, panels):
        for wp in sub["well_position"]:
            g = data[data["well_position"] == wp]
            if g.empty:
                continue
            r = meta.loc[wp]
            r = r.iloc[0] if isinstance(r, pd.DataFrame) else r
            ntc = _is_ntc(r)
            lab = "NTC" if ntc else str(r.get(colour_by, wp))
            style = (dict(color="k", ls="--", lw=1.6, zorder=5) if ntc else
                     dict(color=colours.get(r.get(colour_by), "0.5"), ls="-", lw=1.3, alpha=.9))
            y = g[ycol]
            if logy:
                y = y.clip(lower=1e-4)
            ax.plot(g[xcol], y, label=lab, **style)

        thr = (thresholds or {}).get(name)
        if thr and logy is not None:
            ax.axhline(thr, color="0.5", lw=.8, ls=":")
            ax.text(ax.get_xlim()[0], thr, " Ct threshold", color="0.4",
                    fontsize=7, va="bottom")
        if logy:
            ax.set_yscale("log")
            ax.set_ylim(1e-4, max(10, float(data[ycol].max()) * 2))
        ax.set_title(f"{kind.capitalize()}" + (f" — {name}" if name is not None else ""),
                     fontsize=11)
        ax.set_xlabel(xlabel)
        ax.set_ylabel(ylabel)
        _dedup_legend(ax, fontsize=8, loc="upper left")

    for ax in flat[len(panels):]:
        ax.axis("off")
    if title:
        fig.suptitle(title, fontsize=12)
        fig.tight_layout(rect=[0, 0, 1, .96])
    else:
        fig.tight_layout()
    return fig


def plate_heatmap(wells: pd.DataFrame, value: str = "ct", title: str | None = None):
    """Ct (or any numeric column) laid out in plate geometry. 96 or 384."""
    d = wells.dropna(subset=["row", "col"]).copy()
    if d.empty:
        return None
    rows = sorted(d["row"].unique(), key=lambda r: (len(r), r))
    cols = sorted(int(c) for c in d["col"].dropna().unique())
    grid = pd.DataFrame(np.nan, index=rows, columns=cols)
    for _, r in d.iterrows():
        grid.loc[r["row"], int(r["col"])] = pd.to_numeric(r.get(value), errors="coerce")

    fig, ax = plt.subplots(figsize=(0.55 * len(cols) + 2, 0.55 * len(rows) + 1.5))
    values = np.ma.masked_invalid(grid.values.astype(float))
    x_edges = np.arange(len(cols) + 1) - 0.5
    y_edges = np.arange(len(rows) + 1) - 0.5
    im = ax.pcolormesh(
        x_edges,
        y_edges,
        values,
        cmap="viridis_r",
        shading="flat",
        antialiased=False,
        rasterized=False,
    )
    ax.set_xlim(-0.5, len(cols) - 0.5)
    ax.set_ylim(len(rows) - 0.5, -0.5)
    ax.set_aspect("equal")
    ax.set_xticks(range(len(cols)), cols, fontsize=7)
    ax.set_yticks(range(len(rows)), rows, fontsize=7)
    if len(rows) * len(cols) <= 96:
        for i in range(len(rows)):
            for j in range(len(cols)):
                v = grid.values[i, j]
                ax.text(j, i, "—" if pd.isna(v) else f"{v:.1f}",
                        ha="center", va="center", fontsize=6,
                        color="w" if pd.notna(v) and v < np.nanmean(grid.values) else "k")
    colorbar = fig.colorbar(im, ax=ax, shrink=.8, label=value)
    # Matplotlib rasterizes dense colorbars by default even when the plotted
    # QuadMesh is vector. Keep the SVG export entirely editable.
    colorbar.solids.set_rasterized(False)
    ax.set_title(title or f"{value} by well", fontsize=11)
    fig.tight_layout()
    return fig
