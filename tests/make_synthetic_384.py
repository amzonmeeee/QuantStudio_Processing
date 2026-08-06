"""Build a synthetic 384-well QuantStudio-style export to test parsing.

Deliberately different from the real file: a longer preamble, 'Cq' instead of
'CT', 'Detector Name' instead of 'Target Name', A1-P24 wells.
"""
import numpy as np, pandas as pd
from pathlib import Path

rng = np.random.default_rng(0)
rows = [chr(65 + i) for i in range(16)]
wells = [(r * 24 + c, f"{rows[r]}{c+1}") for r in range(16) for c in range(24)]

res, amp = [], []
for w, wp in wells:
    det = "assayA" if int(wp[1:]) <= 12 else "assayB"
    task = "NTC" if wp.startswith("P") else "UNKNOWN"
    ct = np.nan if task == "NTC" else 18 + (ord(wp[0]) - 65) * 0.8 + rng.normal(0, .1)
    res.append({"Well": w, "Well Position": wp, "Sample Name": f"S{wp[0]}",
                "Detector Name": det, "Task": task,
                "Cq": "Undetermined" if np.isnan(ct) else ct,
                "Threshold": 0.2, "Tm 1": 80 + rng.normal(0, .2)})
    for cyc in range(1, 41):
        drn = 0 if np.isnan(ct) else 4 / (1 + np.exp(-(cyc - ct)))
        amp.append({"Well": w, "Cycle": cyc, "Detector Name": det,
                    "Rn": 0.3 + drn, "dRn": drn})

pre = pd.DataFrame({0: [f"* Meta line {i}" for i in range(63)],
                    1: [f"value {i}" for i in range(63)]})
out = Path(__file__).with_name("synthetic_384.xlsx")
with pd.ExcelWriter(out, engine="openpyxl") as xw:
    for sheet, df in [("Results", pd.DataFrame(res)),
                      ("Amplification Data", pd.DataFrame(amp))]:
        pre.to_excel(xw, sheet_name=sheet, index=False, header=False)
        df.to_excel(xw, sheet_name=sheet, index=False, startrow=len(pre) + 1)
print("wrote", out)
