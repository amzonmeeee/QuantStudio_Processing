"""Reading QuantStudio / 7500 / StepOne exports.

These exports put a variable-length metadata preamble above every sheet and the
column names drift between software versions, so nothing here assumes a fixed
header row or a fixed spelling.
"""
from __future__ import annotations

import re
import warnings
from pathlib import Path

import pandas as pd

# canonical name -> spellings seen across QuantStudio / D&A / SDS / 7500 exports
ALIASES = {
    "well": ["Well", "well", "WELL"],
    "well_position": ["Well Position", "Well position", "Position"],
    "sample": ["Sample Name", "Sample"],
    "target": ["Target Name", "Target", "Detector Name", "Detector"],
    "task": ["Task"],
    "ct": ["CT", "Ct", "Cq", "C\u03c4", "CRT", "Cq (\u0394Rn)"],
    "ct_mean": ["Ct Mean", "Cq Mean", "CT Mean"],
    "ct_sd": ["Ct SD", "Cq SD", "CT SD"],
    "quantity": ["Quantity", "Qty"],
    "threshold": ["Ct Threshold", "Cq Threshold", "Threshold"],
    "baseline_start": ["Baseline Start"],
    "baseline_end": ["Baseline End"],
    "amp_score": ["Amp Score", "AmpScore", "Amp Status"],
    "cq_conf": ["Cq Conf", "Cq Confidence", "CqConf"],
    "tm1": ["Tm1", "Tm 1", "Tm"],
    "tm2": ["Tm2", "Tm 2"],
    "tm3": ["Tm3", "Tm 3"],
    "biogroup": ["Biogroup Name", "Biogroup", "Bio Group Name"],
    "cycle": ["Cycle"],
    "rn": ["Rn"],
    "delta_rn": ["Delta Rn", "dRn", "\u0394Rn"],
    "temperature": ["Temperature", "Temp"],
    "fluorescence": ["Fluorescence", "Fluor"],
    "derivative": ["Derivative", "-d(Fluorescence)/dT", "dF/dT"],
    "omit": ["Omit"],
}
_LOOKUP = {alt.lower(): canon for canon, alts in ALIASES.items() for alt in alts}

# canonical sheet key -> substrings to look for (case-insensitive)
SHEETS = {
    "results": ["results", "result"],
    "setup": ["sample setup", "setup"],
    "amplification": ["amplification data", "amplification"],
    "melt": ["melt curve raw data", "melt curve", "melt region"],
    "raw": ["raw data"],
    "multicomponent": ["multicomponent"],
}

WELL_RE = re.compile(r"^([A-Za-z]{1,2})(\d{1,2})$")


def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Rename known columns to canonical snake_case, leave unknown ones alone."""
    out = df.rename(columns=lambda c: _LOOKUP.get(str(c).strip().lower(), c))
    return out.loc[:, ~out.columns.duplicated()]


def open_book(path) -> pd.ExcelFile:
    """Open the workbook once. Parsing the zip per sheet is the slow path."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return pd.ExcelFile(path)


def find_sheet(book, key: str):
    """Resolve a canonical sheet key to the actual sheet name in the workbook."""
    if not isinstance(book, pd.ExcelFile):
        book = open_book(book)
    names = book.sheet_names
    for want in SHEETS.get(key, [key]):
        for n in names:
            if want == n.strip().lower():
                return n
    for want in SHEETS.get(key, [key]):
        for n in names:
            if want in n.strip().lower():
                return n
    return None


def read_sheet(book, key: str, max_scan: int = 200) -> pd.DataFrame | None:
    """Read one sheet, locating the header row instead of assuming it.

    The header is the first row within `max_scan` whose cells look like a set of
    known column names; this survives the metadata preamble regardless of length.
    """
    if not isinstance(book, pd.ExcelFile):
        book = open_book(book)
    name = find_sheet(book, key)
    if name is None:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        raw = pd.read_excel(book, sheet_name=name, header=None, nrows=max_scan)
        hdr = None
        for i, row in raw.iterrows():
            cells = [str(v).strip().lower() for v in row if pd.notna(v)]
            if not cells:
                continue
            known = sum(c in _LOOKUP for c in cells)
            if known >= 2 and "well" in cells:
                hdr = i
                break
        if hdr is None:
            return None
        df = pd.read_excel(book, sheet_name=name, header=int(hdr))
    df = normalize_columns(df)
    # QuantStudio appends a footer block (Analysis Type, Endogenous Control, ...)
    if "well" in df.columns:
        df = df[pd.to_numeric(df["well"], errors="coerce").notna()].copy()
        df["well"] = df["well"].astype(int)
    return df.reset_index(drop=True)


def read_metadata(book) -> dict:
    """Key/value pairs from the preamble above the Results sheet."""
    if not isinstance(book, pd.ExcelFile):
        book = open_book(book)
    name = find_sheet(book, "results")
    if name is None:
        return {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        raw = pd.read_excel(book, sheet_name=name, header=None, nrows=200)
    meta = {}
    for _, row in raw.iterrows():
        cells = [v for v in row if pd.notna(v)]
        if len(cells) >= 2 and str(cells[0]).startswith("*"):
            meta[str(cells[0]).lstrip("* ").strip()] = cells[1]
        elif str(cells[0] if cells else "").strip() == "Well":
            break
    return meta


def split_well_position(s: pd.Series):
    """'B12' -> ('B', 12). Works for 96 (A-H/1-12) and 384 (A-P/1-24)."""
    m = s.astype(str).str.extract(WELL_RE)
    return m[0].str.upper(), pd.to_numeric(m[1], errors="coerce").astype("Int64")


def infer_plate_format(well_positions: pd.Series) -> int | None:
    """Guess 96 / 384 / 1536 from the observed row letters and column numbers."""
    rows, cols = split_well_position(well_positions)
    if rows.isna().all():
        return None
    nrow = max(ord(r[-1]) - 64 for r in rows.dropna().unique())
    ncol = int(cols.dropna().max())
    for fmt, (R, C) in {96: (8, 12), 384: (16, 24), 1536: (32, 48)}.items():
        if nrow <= R and ncol <= C:
            return fmt
    return None


#: sheets read by default. Raw Data and Multicomponent Data are large and
#: nothing downstream uses them, so they are opt-in.
DEFAULT_SHEETS = ("results", "setup", "amplification", "melt")


def load(path, sheets: tuple[str, ...] = DEFAULT_SHEETS) -> dict:
    """Read an export into canonical DataFrames.

    Returns a dict with keys: results, setup, amplification, melt, raw,
    multicomponent, meta, plate_format. Sheets not requested, and sheets the
    workbook does not contain, are None.
    """
    book = open_book(Path(path))
    out = {k: (read_sheet(book, k) if k in sheets else None) for k in SHEETS}
    out["meta"] = read_metadata(book)

    res = out["results"]
    if res is None:
        raise ValueError(f"no Results-like sheet with a locatable header in {path}")

    # Amplification Data has no well_position in most exports -> backfill it
    wp = res.set_index("well")["well_position"].to_dict() if "well_position" in res else {}
    for k in ("amplification", "melt", "raw", "multicomponent"):
        d = out[k]
        if d is not None and "well_position" not in d.columns and wp:
            d["well_position"] = d["well"].map(wp)

    out["plate_format"] = (
        infer_plate_format(res["well_position"]) if "well_position" in res else None
    )
    return out
