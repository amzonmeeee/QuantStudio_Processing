#!/usr/bin/env python3
"""
qPCR: cargo (plasmid/transposon) copies per phage genome, from a QuantStudio export.

Usage:
    python plot_cargo_vs_phage.py <instrument_export.xlsx> [-o out.png] [--csv]

What it does
    1. reads the Results sheet (per-well Ct) and the Raw Data sheet (raw filter signal)
    2. maps every well to a sample using PLATE_MAP / SAMPLES below
    3. checks every no-template control, including ones the software never assigned a
       Target Name to (those are missing from the Results sheet, so Rn is rebuilt from
       Raw Data as SYBR/ROX)
    4. ratio = 2^-(Ct_cargo - Ct_phage), with the NTC's own signal subtracted off in
       concentration space; conditions whose cargo Ct is not >1 cycle below its NTC are
       reported as an upper bound instead of a point estimate
    5. writes the two-panel figure

To reuse on another run, edit only the CONFIG block.
"""
import argparse, re, sys
import numpy as np, pandas as pd
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

# ============================== CONFIG ==============================
HEADER_ROW = 46          # 0-based row of the 'Well / Well Position / ...' header in each sheet
N_CYCLES   = 40
SYBR_COL, ROX_COL = 'x1-m1', 'x4-m4'     # Raw Data columns used to rebuild Rn
DRN_AMPLIFIED = 0.15     # delta Rn at the last cycle above which a control counts as contaminated
ROX_EMPTY     = 5e4      # ROX below this => the well was never filled
DETECT_MARGIN = 1.0      # cargo must be this many cycles below its NTC to be called detected

PHAGE_COLOUR = {'95': '#1f77b4', '96': '#2ca02c', '107': '#ff7f0e'}
CARGO_STYLE  = {'0021': ('o', '#d62728'), 'aicr': ('^', '#7b3fa0')}
PHAGE_TARGET = 'phivc8'          # the primer set that measures the phage genome

# plate map: (row, column) -> sample id.  Columns are the real 1-12 plate columns.
BLOCKS = {'a': (2, 3, 4), 'b': (5, 6, 7), 'c': (8, 9, 10)}   # primer-set column blocks
PLATE_MAP = {}
for _row, _ids in {
    'A': ('a1d', 'b1d', 'c1d'), 'B': ('a1', 'b1', 'c1'),
    'C': ('a2d', 'b2d', 'c2d'), 'D': ('a2', 'b2', 'c2'),
    'E': ('a3', 'b3', 'c3d'),   'F': ('NTCa', 'NTCb', 'c3'),
    'G': (None, None, 'c4'),    'H': ('NTC', None, 'NTCc'),
}.items():
    for _blk, _sid in zip('abc', _ids):
        if _sid:
            for _col in BLOCKS[_blk]:
                PLATE_MAP[f'{_row}{_col}'] = _sid

# sample id -> (phage, fraction, template dilution, primer set)
SAMPLES = {
    'a1d': ('95', 'pellet', '1:10', '0021'),   'a1': ('95', 'pellet', 'neat', '0021'),
    'c1d': ('95', 'pellet', '1:10', 'phivc8'), 'c1': ('95', 'pellet', 'neat', 'phivc8'),
    'b1d': ('96', 'pellet', '1:10', 'aicr'),   'b1': ('96', 'pellet', 'neat', 'aicr'),
    'c2d': ('96', 'pellet', '1:10', 'phivc8'), 'c2': ('96', 'pellet', 'neat', 'phivc8'),
    'a2d': ('107', 'pellet', '1:10', '0021'),  'a2': ('107', 'pellet', 'neat', '0021'),
    'b2d': ('107', 'pellet', '1:10', 'aicr'),  'b2': ('107', 'pellet', 'neat', 'aicr'),
    'c3d': ('107', 'pellet', '1:10', 'phivc8'),'c3': ('107', 'pellet', 'neat', 'phivc8'),
    'a3': ('107', 'supernatant', 'neat', '0021'),
    'b3': ('107', 'supernatant', 'neat', 'aicr'),
    'c4': ('107', 'supernatant', 'neat', 'phivc8'),
}
# no-template controls: sample id -> primer set it controls (None = not a primer-specific NTC)
NTC_OF = {'NTCa': '0021', 'NTCb': 'aicr', 'NTCc': 'phivc8', 'NTC': None}

# rows of the left panel and of the bar panel, top to bottom
CONDITIONS = [('107', 'supernatant', 'neat'), ('107', 'pellet', '1:10'), ('107', 'pellet', 'neat'),
              ('96', 'pellet', '1:10'), ('96', 'pellet', 'neat'),
              ('95', 'pellet', '1:10'), ('95', 'pellet', 'neat')]
BARS = [('95', 'pellet', '0021'), ('96', 'pellet', 'aicr'), ('107', 'pellet', '0021'),
        ('107', 'pellet', 'aicr'), ('107', 'supernatant', '0021'), ('107', 'supernatant', 'aicr')]
BAR_FLOOR = 1e-6         # left edge of the log axis; bars are drawn from here
# ============================ END CONFIG ============================


def load_wells(path):
    """Per-well Ct table, joined to the plate map."""
    res = pd.read_excel(path, sheet_name='Results', header=HEADER_ROW).iloc[:96].copy()
    res['well'] = res['Well Position'].astype(str).str.strip()
    res = res[res['Target Name'].notna()]
    rows = []
    for _, r in res.iterrows():
        sid = PLATE_MAP.get(r['well'])
        if sid is None:
            continue                      # well not on the map (e.g. a stray target assignment)
        if sid in NTC_OF:
            phage, frac, dil, primer = 'NTC', 'NTC', '-', NTC_OF[sid] or r['Target Name']
        else:
            phage, frac, dil, primer = SAMPLES[sid]
        if r['Target Name'] != primer:
            print(f'  ! {r["well"]}: map says {primer}, file says {r["Target Name"]}', file=sys.stderr)
        rows.append(dict(well=r['well'], sid=sid, phage=phage, fraction=frac, dilution=dil,
                         target=r['Target Name'],
                         ct=pd.to_numeric(r['CT'], errors='coerce'), tm=r['Tm1']))
    return pd.DataFrame(rows)


def control_qc(path):
    """Rn rebuilt from raw filter signal, so controls missing from Results are still checked."""
    raw = pd.read_excel(path, sheet_name='Raw Data', header=HEADER_ROW)
    raw['well'] = raw['Well Position'].astype(str).str.strip()
    raw = raw[raw['Cycle'] <= N_CYCLES].copy()
    raw['Rn'] = raw[SYBR_COL] / raw[ROX_COL]
    def natural(w):                       # A2 < A10, not A10 < A2
        return (w[0], int(re.sub(r'\D', '', w)))
    out = []
    for well, sid in sorted(PLATE_MAP.items(), key=lambda kv: natural(kv[0])):
        if sid not in NTC_OF:
            continue
        s = raw[raw.well == well].sort_values('Cycle')
        if s.empty:
            continue
        rn, rox = s['Rn'].values, s[ROX_COL].mean()
        drn = rn[-3:].mean() - rn[4:15].mean()
        verdict = ('EMPTY WELL (no ROX) - any Ct is a normalisation artefact' if rox < ROX_EMPTY
                   else 'AMPLIFIED - contaminated' if drn > DRN_AMPLIFIED
                   else 'clean (no amplification)')
        out.append(dict(well=well, control=sid, primer=NTC_OF[sid] or '-',
                        rox_mean=rox, drn_final=drn, verdict=verdict))
    return pd.DataFrame(out)


def summarise(wells):
    g = (wells.groupby(['sid', 'phage', 'fraction', 'dilution', 'target'], as_index=False)
               .agg(n=('ct', 'count'), ct_mean=('ct', 'mean'), ct_sd=('ct', 'std'), tm=('tm', 'mean')))
    ntc = {NTC_OF[sid]: g.loc[g.sid == sid, 'ct_mean'].iloc[0]
           for sid in NTC_OF if NTC_OF[sid] and (g.sid == sid).any()
           and g.loc[g.sid == sid, 'ct_mean'].notna().all()}
    return g, ntc


def ratios(g, ntc):
    ct = g.set_index(['phage', 'fraction', 'dilution', 'target'])['ct_mean']
    out = []
    for phage, frac, dil in {(p, f, d) for p, f, d, _ in ct.index if p != 'NTC'}:
        ct_phage = ct.get((phage, frac, dil, PHAGE_TARGET), np.nan)
        if np.isnan(ct_phage):
            continue
        for cargo in CARGO_STYLE:
            ct_cargo = ct.get((phage, frac, dil, cargo), np.nan)
            if np.isnan(ct_cargo):
                continue
            bg = 2.0 ** -ntc[cargo] if cargo in ntc else 0.0
            signal = 2.0 ** -ct_cargo - bg
            detected = (ntc[cargo] - ct_cargo) > DETECT_MARGIN if cargo in ntc else True
            out.append(dict(phage=phage, fraction=frac, dilution=dil, cargo=cargo,
                            ct_cargo=ct_cargo, ct_phage=ct_phage, dct=ct_cargo - ct_phage,
                            ratio_raw=2.0 ** -(ct_cargo - ct_phage),
                            ratio_corr=signal / 2.0 ** -ct_phage if signal > 0 else np.nan,
                            upper_bound=2.0 ** -(ntc[cargo] - ct_phage) if cargo in ntc else np.nan,
                            detected=detected))
    return pd.DataFrame(out)


def figure(g, r, ntc, qc, out_png):
    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(15.5, 6.2), gridspec_kw={'width_ratios': [1.15, 1]})
    ct = g.set_index(['phage', 'fraction', 'dilution', 'target'])

    # ---- left: Ct per condition ----
    lo = min(ntc.values())
    ax.axvspan(lo, 40, color='#f8d7da', alpha=.55, zorder=0)
    for cargo, colour in [('0021', '#d62728'), ('aicr', '#7b3fa0')]:
        if cargo in ntc:
            ax.axvline(ntc[cargo], ls='--', lw=1.6, color=colour, zorder=1)
            ax.text(ntc[cargo] + (-.16 if cargo == '0021' else .18), 3.0, f'{cargo} NTC',
                    color=colour, ha='right' if cargo == '0021' else 'left',
                    va='center', fontsize=8.5, rotation=90)
    for i, cond in enumerate(CONDITIONS):
        y = len(CONDITIONS) - 1 - i
        marks = [(PHAGE_TARGET, 's', PHAGE_COLOUR.get(cond[0], '0.5'), 78)] + \
                [(c, m, col, 74) for c, (m, col) in CARGO_STYLE.items()]
        for tgt, mk, colour, size in marks:
            key = (cond[0], cond[1], cond[2], tgt)
            if key not in ct.index:
                continue
            m, s = ct.loc[key, 'ct_mean'], ct.loc[key, 'ct_sd']
            ax.errorbar(m, y, xerr=s, fmt='none', ecolor='0.35', elinewidth=1.1, capsize=3, zorder=3)
            ax.scatter(m, y, marker=mk, s=size, color=colour, edgecolor='k', lw=.7, zorder=4)
    ax.set_yticks(range(len(CONDITIONS)))
    ax.set_yticklabels(['  '.join(c) for c in CONDITIONS[::-1]], fontsize=10)
    ax.set_xlim(13, 37); ax.set_xlabel('Ct  (mean of replicates, ±SD)', fontsize=11)
    ax.set_title('Ct by condition\nsignal inside the pink band is indistinguishable from the contaminated NTC',
                 fontsize=11)
    ax.grid(axis='x', ls=':', color='0.75'); ax.set_axisbelow(True)
    clean = qc[(qc.primer == PHAGE_TARGET) & qc.verdict.str.startswith('clean')]
    if len(clean):
        ax.text(13.4, .32, f'{PHAGE_TARGET} NTC ({clean.well.iloc[0]}-{clean.well.iloc[-1]}): no amplification',
                fontsize=8.5, color='0.25', style='italic')
    ax.legend(handles=[Line2D([], [], ls='', marker=CARGO_STYLE[c][0], mfc=CARGO_STYLE[c][1],
                              mec='k', ms=8, label=f'{c} (cargo/plasmid)') for c in CARGO_STYLE] +
                      [Line2D([], [], ls='', marker='s', mfc='0.6', mec='k', ms=8,
                              label=f'{PHAGE_TARGET} (phage genome)')],
              loc='lower right', fontsize=9, framealpha=.95)

    # ---- right: cargo : phage ratio ----
    idx = r.set_index(['phage', 'fraction', 'cargo', 'dilution'])
    for i, bar in enumerate(BARS):
        y = len(BARS) - 1 - i
        if (*bar, 'neat') not in idx.index:
            continue
        neat = idx.loc[(*bar, 'neat')]
        dil = idx.loc[(*bar, '1:10')] if (*bar, '1:10') in idx.index else None
        if neat.detected:
            v = neat.ratio_corr
            ax2.barh(y, v - BAR_FLOOR, left=BAR_FLOOR, color='#2e8b3d', edgecolor='k', height=.6, zorder=3)
            dv = dil.ratio_corr if dil is not None and dil.detected else v
            ax2.text(max(v, dv) * 1.4, y, f'{v:.1e}', va='center', fontsize=9.5)
        else:
            v = neat.upper_bound
            ax2.barh(y, v - BAR_FLOOR, left=BAR_FLOOR, color='0.78', edgecolor='k',
                     hatch='//', height=.6, zorder=3)
            ax2.text(v * 1.4, y, f'$\\leq$ {v:.1e}', va='center', fontsize=9.5)
        if dil is not None and dil.detected:
            ax2.scatter(dil.ratio_corr, y, marker='D', s=42, color='w', edgecolor='k', zorder=5)
    ax2.set_yticks(range(len(BARS)))
    ax2.set_yticklabels([f'phage {p}  {f}   ({c})' for p, f, c in BARS[::-1]], fontsize=10)
    ax2.set_xscale('log'); ax2.set_xlim(BAR_FLOOR, 6e-2)
    ax2.set_xlabel('cargo : phage genome   ($2^{-\\Delta Ct}$, NTC-subtracted, neat)', fontsize=11)
    ax2.set_title('Plasmid / cargo copies per phage genome', fontsize=12)
    ax2.grid(axis='x', ls=':', color='0.75'); ax2.set_axisbelow(True)
    ax2.legend(handles=[Patch(fc='#2e8b3d', ec='k', label='point estimate (neat)'),
                        Patch(fc='0.78', ec='k', hatch='//', label='upper bound only (not detected)'),
                        Line2D([], [], ls='', marker='D', mfc='w', mec='k', ms=7, label='1:10 dilution estimate')],
               loc='upper center', bbox_to_anchor=(.5, -.13), ncol=3, fontsize=9, frameon=False)
    plt.tight_layout()
    fig.savefig(out_png, dpi=200, bbox_inches='tight')
    print(f'wrote {out_png}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('-o', '--out', default='fig_plasmid_vs_phage.png')
    ap.add_argument('--csv', action='store_true', help='also write wells/summary/ratios/control_qc CSVs')
    a = ap.parse_args()

    wells = load_wells(a.xlsx)
    qc = control_qc(a.xlsx)
    g, ntc = summarise(wells)
    r = ratios(g, ntc)

    print('\ncontrol wells');  print(qc.to_string(index=False))
    print('\nNTC Ct used for background subtraction:',
          {k: round(v, 2) for k, v in ntc.items()})
    print('\ncargo : phage genome')
    print(r.sort_values(['phage', 'fraction', 'cargo', 'dilution']).to_string(index=False))
    if a.csv:
        for name, df in [('wells', wells), ('summary', g), ('ratios', r), ('control_qc', qc)]:
            df.to_csv(f'{name}.csv', index=False)
    figure(g, r, ntc, qc, a.out)


if __name__ == '__main__':
    main()
