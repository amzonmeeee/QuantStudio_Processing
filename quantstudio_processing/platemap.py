"""Attaching experiment design to wells.

Two ways in, both optional:

1. A CSV with a `well` column (position like `B2`) plus any other columns you
   want carried through.
2. A YAML file using plate-range shorthand, which is far less painful for 384.

If neither is given, the design is taken from the export's own Sample Setup
sheet, so the tool still works with no config at all.
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from .io import split_well_position

RANGE_RE = re.compile(r"^([A-Za-z]{1,2})(\d{1,2})\s*[:\-]\s*([A-Za-z]{1,2})(\d{1,2})$")
SINGLE_RE = re.compile(r"^([A-Za-z]{1,2})(\d{1,2})$")


def _row_index(letters: str) -> int:
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def _row_label(n: int) -> str:
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def expand_wells(spec) -> list[str]:
    """Expand plate shorthand into well positions.

    'B2'          -> ['B2']
    'B2:E4'       -> the rectangular block rows B-E x cols 2-4
    'B2, F2:F4'   -> union
    ['B2:B4','C6'] -> union
    """
    if isinstance(spec, (list, tuple)):
        out = []
        for s in spec:
            out += expand_wells(s)
        return list(dict.fromkeys(out))

    text = str(spec).strip()
    if "," in text:
        return expand_wells([p for p in text.split(",") if p.strip()])

    m = RANGE_RE.match(text)
    if m:
        r1, c1, r2, c2 = _row_index(m[1]), int(m[2]), _row_index(m[3]), int(m[4])
        r1, r2 = sorted((r1, r2))
        c1, c2 = sorted((c1, c2))
        return [f"{_row_label(r)}{c}"
                for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]

    m = SINGLE_RE.match(text)
    if m:
        return [f"{m[1].upper()}{int(m[2])}"]

    raise ValueError(f"cannot parse well spec: {spec!r}")


def from_yaml(path) -> pd.DataFrame:
    """Read a YAML platemap into a tidy well table.

    Any top-level key other than `name`/`notes` becomes a column; each key maps
    values to well specs. Example:

        name: 2026-08-03 pre-run
        assay:
          aicr:  [B2:E4, F2]
          "0021": [B6:E8, F3]
        task:
          NTC: F2:F4
        input_relative:
          1:     [B6:C8, B2:B4]
          1e-3:  [C2:E4]
    """
    import yaml

    doc = yaml.safe_load(Path(path).read_text())
    frames = {}
    for field, mapping in doc.items():
        if field in ("name", "notes", "description"):
            continue
        if not isinstance(mapping, dict):
            raise ValueError(f"platemap field {field!r} must be a mapping")
        rows = []
        for value, spec in mapping.items():
            for w in expand_wells(spec):
                rows.append({"well_position": w, field: value})
        s = pd.DataFrame(rows)
        dup = s["well_position"].duplicated()
        if dup.any():
            raise ValueError(
                f"field {field!r} assigns these wells twice: "
                f"{sorted(s.loc[dup, 'well_position'])}"
            )
        frames[field] = s.set_index("well_position")

    if not frames:
        return pd.DataFrame(columns=["well_position"])
    out = pd.concat(frames.values(), axis=1).reset_index()
    out.attrs["name"] = doc.get("name", Path(path).stem)
    return out


def from_csv(path) -> pd.DataFrame:
    df = pd.read_csv(path)
    cols = {c.lower(): c for c in df.columns}
    key = cols.get("well_position") or cols.get("well position") or cols.get("well")
    if key is None:
        raise ValueError("platemap CSV needs a 'well' or 'well_position' column")
    df = df.rename(columns={key: "well_position"})
    df["well_position"] = df["well_position"].astype(str).str.upper().str.replace(
        r"^([A-Z]+)0*(\d+)$", r"\1\2", regex=True)
    return df


def load_platemap(path) -> pd.DataFrame:
    p = Path(path)
    if p.suffix.lower() in (".yaml", ".yml"):
        return from_yaml(p)
    return from_csv(p)


def annotate(results: pd.DataFrame, platemap: pd.DataFrame | None,
             setup: pd.DataFrame | None = None) -> pd.DataFrame:
    """Merge design onto the results table and add row/column helpers."""
    df = results.copy()

    if setup is not None and "biogroup" in setup.columns and "biogroup" not in df.columns:
        df = df.merge(setup[["well", "biogroup"]], on="well", how="left")

    if platemap is not None and len(platemap):
        extra = [c for c in platemap.columns if c != "well_position"]
        clash = [c for c in extra if c in df.columns]
        df = df.drop(columns=clash)
        df = df.merge(platemap, on="well_position", how="left")
        missing = set(platemap["well_position"]) - set(df["well_position"])
        if missing:
            raise ValueError(
                f"platemap references wells not present in the export: "
                f"{sorted(missing)[:10]}{'...' if len(missing) > 10 else ''}"
            )

    df["row"], df["col"] = split_well_position(df["well_position"])
    return df


def compress_wells(wells) -> list[str]:
    """Inverse of `expand_wells`: a well list back into range shorthand.

    Greedy rectangle merge — contiguous column runs within a row, then
    identical runs merged down consecutive rows. Output round-trips through
    `expand_wells`, which the tests check.
    """
    parsed = []
    for w in wells:
        m = SINGLE_RE.match(str(w).strip())
        if not m:
            raise ValueError(f"cannot parse well: {w!r}")
        parsed.append((_row_index(m[1]), int(m[2])))
    if not parsed:
        return []

    runs: dict[tuple[int, int], list[int]] = {}
    by_row: dict[int, list[int]] = {}
    for r, c in sorted(set(parsed)):
        by_row.setdefault(r, []).append(c)
    for r, cols in by_row.items():
        start = prev = cols[0]
        for c in cols[1:] + [None]:
            if c is not None and c == prev + 1:
                prev = c
                continue
            runs.setdefault((start, prev), []).append(r)
            if c is not None:
                start = prev = c

    out = []
    for (c1, c2), rows in runs.items():
        rows = sorted(rows)
        r1 = prev = rows[0]
        for r in rows[1:] + [None]:
            if r is not None and r == prev + 1:
                prev = r
                continue
            a, b = f"{_row_label(r1)}{c1}", f"{_row_label(prev)}{c2}"
            out.append(a if a == b else f"{a}:{b}")
            if r is not None:
                r1 = prev = r

    return sorted(out, key=lambda s: (len(s), s))
