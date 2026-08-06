"""QC flags, replicate collapsing and standard curves.

Nothing here hard-codes a plate layout: which columns identify an assay and
which identify a replicate group are arguments.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

DEFAULTS = dict(
    ntc_margin=3.0,      # cycles a sample must lead its NTC by
    sd_max=0.5,          # replicate Ct SD warning
    amp_score_min=1.24,  # QuantStudio defaults
    cq_conf_min=0.8,
    ct_min=10.0,         # below this, baseline subtraction is unreliable
    tm_tol=1.0,          # deviation from the assay's modal Tm
)


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    """Coerce Ct to numeric ('Undetermined' -> NaN) and flag detection.

    Undetermined is deliberately left as NaN rather than imputed to the cycle
    count: substituting 40 biases every mean it touches.
    """
    out = df.copy()
    out["ct"] = pd.to_numeric(out.get("ct"), errors="coerce")
    out["detected"] = out["ct"].notna()
    if "omit" in out.columns:
        out = out[~out["omit"].astype(str).str.lower().isin(["true", "1", "yes"])]
    return out


def _ntc_ct(df, assay_col):
    """Earliest NTC Ct per assay, or NaN where the NTC is clean."""
    if "task" not in df.columns:
        return {}
    ntc = df[df["task"].astype(str).str.upper() == "NTC"]
    if ntc.empty:
        return {}
    return ntc.groupby(assay_col)["ct"].min().to_dict()


def _modal_tm(df, assay_col):
    """Median Tm1 of detected non-NTC wells, per assay."""
    if "tm1" not in df.columns:
        return {}
    d = df[df["detected"]]
    if "task" in df.columns:
        d = d[d["task"].astype(str).str.upper() != "NTC"]
    return d.groupby(assay_col)["tm1"].median().to_dict()


def qc(df: pd.DataFrame, assay_col: str = "target", **kw) -> pd.DataFrame:
    """Per-well QC flags. Returns the frame with `qc_flags` and `qc_pass`."""
    p = {**DEFAULTS, **kw}
    df = prepare(df)
    if assay_col not in df.columns:
        raise KeyError(f"assay column {assay_col!r} not in table; "
                       f"have {sorted(df.columns)}")

    ntc = _ntc_ct(df, assay_col)
    tms = _modal_tm(df, assay_col)
    is_ntc = (df["task"].astype(str).str.upper() == "NTC"
              if "task" in df.columns else pd.Series(False, index=df.index))

    flags = []
    for i, r in df.iterrows():
        f = []
        a = r[assay_col]
        if is_ntc[i]:
            if pd.notna(r["ct"]):
                f.append(f"NTC amplifies (Ct {r['ct']:.1f})")
        else:
            n = ntc.get(a, np.nan)
            if pd.notna(n) and pd.notna(r["ct"]) and r["ct"] > n - p["ntc_margin"]:
                f.append(f"within {p['ntc_margin']:g} cycles of NTC ({n:.1f})")
            if pd.notna(r["ct"]) and r["ct"] < p["ct_min"]:
                f.append(f"Ct {r['ct']:.1f} below reliable baseline range")
        if pd.notna(r["ct"]):
            if pd.notna(r.get("amp_score")) and r.get("amp_score") < p["amp_score_min"]:
                f.append(f"amp score {r['amp_score']:.2f}")
            if pd.notna(r.get("cq_conf")) and r.get("cq_conf") < p["cq_conf_min"]:
                f.append(f"Cq conf {r['cq_conf']:.2f}")
            t, exp = r.get("tm1"), tms.get(a, np.nan)
            if pd.notna(t) and pd.notna(exp) and abs(t - exp) > p["tm_tol"]:
                f.append(f"Tm {t:.1f} vs assay median {exp:.1f}")
        flags.append("; ".join(f))

    df = df.copy()
    df["qc_flags"] = flags
    df["qc_pass"] = df["qc_flags"] == ""
    return df


def summarize(df: pd.DataFrame, group_cols, **kw) -> pd.DataFrame:
    """Collapse replicates over `group_cols`.

    Ct mean/SD are computed over detected wells only; `n_detected` carries the
    partial-detection information that the mean would otherwise hide.
    """
    p = {**DEFAULTS, **kw}
    group_cols = [group_cols] if isinstance(group_cols, str) else list(group_cols)
    missing = [c for c in group_cols if c not in df.columns]
    if missing:
        raise KeyError(f"grouping columns not found: {missing}")

    agg = {"n_wells": ("well", "size"), "n_detected": ("detected", "sum"),
           "ct_mean": ("ct", "mean"), "ct_sd": ("ct", "std")}
    if "tm1" in df.columns:
        agg |= {"tm_mean": ("tm1", "mean"), "tm_sd": ("tm1", "std")}

    out = df.groupby(group_cols, dropna=False).agg(**agg).reset_index()

    def call(r):
        if r["n_detected"] == 0:
            return "not detected"
        if r["n_detected"] < r["n_wells"]:
            return f"partial {int(r['n_detected'])}/{int(r['n_wells'])}"
        if pd.notna(r["ct_sd"]) and r["ct_sd"] > p["sd_max"]:
            return f"high replicate SD ({r['ct_sd']:.2f})"
        return "ok"

    out["call"] = out.apply(call, axis=1)
    return out


def standard_curve(df: pd.DataFrame, quantity_col: str = "quantity",
                   assay_col: str = "target",
                   qc_pass_only: bool = False) -> pd.DataFrame:
    """Fit log10(quantity) vs Ct per assay.

    Works off any numeric quantity column, so it fits either a real standard
    curve (`task == STANDARD`) or a dilution series you annotated yourself.
    """
    rows = []
    for assay, g in df.groupby(assay_col):
        d = g[g["detected"] & pd.to_numeric(g[quantity_col], errors="coerce").notna()]
        d = d[pd.to_numeric(d[quantity_col], errors="coerce") > 0]
        if qc_pass_only and "qc_pass" in d.columns:
            d = d[d["qc_pass"]]
        n_flagged = int((~d["qc_pass"]).sum()) if "qc_pass" in d.columns else 0
        if d[quantity_col].nunique() < 2:
            continue
        x = np.log10(pd.to_numeric(d[quantity_col]))
        y = d["ct"].astype(float)
        slope, intercept = np.polyfit(x, y, 1)
        pred = slope * x + intercept
        ss_res = float(((y - pred) ** 2).sum())
        ss_tot = float(((y - y.mean()) ** 2).sum())
        rows.append({
            assay_col: assay, "n_points": len(d), "n_flagged": n_flagged,
            "slope": slope,
            "y_intercept": intercept,
            "r2": 1 - ss_res / ss_tot if ss_tot else np.nan,
            "efficiency_pct": (10 ** (-1 / slope) - 1) * 100,
            "ct_at_1_copy": intercept,
        })
    return pd.DataFrame(rows)


def delta_ct(summary: pd.DataFrame, assay_col: str, sample_col: str,
             target_assay: str, reference_assay: str) -> pd.DataFrame:
    """dCt = Ct(target assay) - Ct(reference assay), matched on sample."""
    w = summary.pivot_table(index=sample_col, columns=assay_col,
                            values="ct_mean", aggfunc="first")
    for a in (target_assay, reference_assay):
        if a not in w.columns:
            raise KeyError(f"assay {a!r} not in summary; have {list(w.columns)}")
    out = pd.DataFrame({
        f"ct_{target_assay}": w[target_assay],
        f"ct_{reference_assay}": w[reference_assay],
    })
    out["dct"] = out.iloc[:, 0] - out.iloc[:, 1]
    out["fold_2^-dct"] = 2 ** (-out["dct"])
    return out.reset_index()
