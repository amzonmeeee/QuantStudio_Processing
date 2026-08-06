# QuantStudio_Processing

Tidy, QC and plot qPCR exports from QuantStudio / 7500 / StepOne instruments —
from the command line, from Python, or from a local browser GUI where you paint
the plate layout yourself.

The instrument export is awkward to work with: a variable-length metadata
preamble sits above every sheet, `Undetermined` poisons any numeric column,
replicates are only grouped if you happened to name them identically during
setup, and the column names drift between software versions. This package deals
with all of that and gives you a tidy per-well table, QC flags, replicate
summaries and plots.

Nothing is hard-coded to a plate layout. Plate size (96 / 384 / 1536), which
column identifies an assay and which identifies a replicate group are all
either detected or passed in — and in the GUI, the layout in the file is only a
starting point you can overwrite.

## Install

```bash
git clone https://github.com/amzonmeeee/QuantStudio_Processing
cd QuantStudio_Processing
pip install -e .
```

## The GUI

```bash
qsp gui                 # opens http://127.0.0.1:8765
```

Drop an export on the page. The plate fills in from the file's own Sample Setup
so you have something to work from, and from there:

- **Fields** are the columns you want in the results — `assay`, `sample`,
  `quantity`, or anything else you name. Add as many as you like.
- **Values** are what a field can be. Pick one, then drag across the plate.
  Row and column headers paint a whole line; alt-drag erases; ⌘Z / Ctrl+Z undoes.
- **Fill from file** re-imports the export's own layout, and **Hold to clear
  plate** throws yours away. Both are undoable.
- **96 / 384** switches the grid independently of what the file says, so an
  export that only used part of a plate can still be laid out the way you ran it.
- **Copy platemap** puts the painted layout on the clipboard as the same YAML
  the CLI reads, so a layout designed in the GUI becomes a file you can commit.
- **Download workbook** gives you the processed .xlsx.

Wells with no data in the export are drawn recessed and can't be painted; the
status line says how many were skipped.

The interface asks Google Fonts for Archivo and IBM Plex Mono and falls back to
system faces on a machine that is offline. Nothing else in the app needs the
network.

## Command line

With no configuration, the design is taken from the export's Sample Setup sheet:

```bash
qsp run_2026-08-03.xlsx -o out/
```

Output in `out/`: `*_processed.xlsx` (per-well, summary, standard curve),
`amplification.png`, `melt.png`, `plate_ct.png`.

### Describing the plate in a file

Sample Setup rarely holds what you actually want. Write a platemap instead —
the range shorthand keeps this tolerable even at 384:

```yaml
name: 2026-08-03 pre-run

assay:                    # every top-level key becomes a column
  aicr:   [B2:E4, F2]     # 'B2:E4' is the rectangular block rows B-E x cols 2-4
  "0021": [B6:E8, F3]
  none:   [F4]

sample:
  "1 : 1":       [B2:B4, B6:B8]
  "1 : 1e-3":    [C2:C4, C6:C8]
  "no template": [F2:F4]

quantity:                 # copies per reaction, used for the standard curve
  3.01e6: [B2:B4, B6:C8]
  3.01e3: [C2:E4]
```

```bash
qsp run.xlsx -m platemaps/2026-08-03.yaml \
    --assay-col assay --group-cols assay,sample --dct aicr 0021
```

A CSV with a `well` column plus arbitrary extra columns works too. Overlapping
well assignments and wells that don't exist in the export both raise rather
than silently producing NaN.

### Options

| flag | meaning |
|---|---|
| `-m, --platemap` | YAML or CSV design file |
| `--assay-col` | column identifying the primer set / assay (default `target`) |
| `--group-cols` | replicate keys, comma separated (default `<assay-col>,sample`) |
| `--colour-by` | curve colour column |
| `--quantity-col` | numeric input column for the standard curve fit |
| `--dct TARGET REF` | ΔCt between two assays, matched on sample |
| `--sc-qc-pass-only` | fit the standard curve on QC-passing wells only |
| `--ntc-margin`, `--sd-max`, `--ct-min` | QC thresholds |
| `--no-plots` | skip figures |

## As a library

```python
from quantstudio_processing import io, platemap, analysis, plot

b = io.load("run.xlsx")
wells = platemap.annotate(b["results"], platemap.load_platemap("map.yaml"), b["setup"])
wells = analysis.qc(wells, assay_col="assay")
summary = analysis.summarize(wells, ["assay", "sample"])
fig = plot.curves(wells, b["amplification"], "amplification",
                  facet_by="assay", colour_by="sample")
```

`io.load` reads Results, Sample Setup, Amplification Data and Melt Curve Raw
Data. Raw Data and Multicomponent Data are large and nothing downstream uses
them, so ask for them explicitly: `io.load(path, sheets=tuple(io.SHEETS))`.

## What the QC checks

Per well:

- NTC amplifies at all
- sample Ct within `--ntc-margin` cycles of its own assay's NTC — the practical
  floor of the assay, and the reason a "positive" at Ct 35 next to an NTC at
  Ct 35.6 is not a positive
- Ct below `--ct-min` (default 10), where baseline subtraction is unreliable and
  the reported Ct should not be used quantitatively
- Amp Score / Cq Conf below the QuantStudio defaults
- Tm more than `--tm-tol` from the assay's median Tm

Per replicate group: number detected out of number of wells (partial detection
is reported rather than hidden inside a mean), and Ct SD above `--sd-max`.

`Undetermined` is kept as NaN and never imputed to the cycle count —
substituting 40 biases every mean it touches.

## Interface behaviour

The GUI follows [interior.dev](https://www.interior.dev)'s three rules, in plain
JS rather than React:

- **Nothing reflows on a state change.** The run button measures every label it
  can reach (`Run analysis` / `Running` / `Run again`) and pins the widest
  before it needs it, so the toolbar beside it never shifts. Result tables load
  behind a skeleton whose rows are the height the real rows will be.
- **Transitions are interruptible.** Everything animates `transform` and
  `opacity` only, so a change part-way through interpolates from where the
  element actually is instead of replaying from the start.
- **Motion is never the only channel.** With `prefers-reduced-motion` on,
  durations collapse to 1 ms but the same status text, colour and counts still
  arrive.

Also from that set: press depth on every control, released on pointer cancel as
well as on a clean click; a spinner that waits 180 ms before appearing and stays
at least 420 ms once it has; hold-to-confirm on the destructive clear, cancelled
by releasing early, leaving the button or Escape; a bounded toast stack; and a
well inspector whose transform origin is the well that opened it.

The plate carries two independent channels at once — fill is your assignment,
hatching plus a red ring is a QC flag — so neither piece of information hides
the other. The categorical colours are the instrument's own dye channels (FAM,
SYBR, VIC, ROX, Cy5), and the selection colour is the 470 nm excitation blue.

## Project layout

```
quantstudio_processing/
  io.py         reading exports: sheet lookup, header detection, column aliases
  platemap.py   design files and well-range shorthand, both directions
  analysis.py   Ct handling, QC flags, replicate summaries, standard curve, dCt
  plot.py       amplification and melt curves, plate heatmap
  cli.py        `qsp` and `qsp gui`
  webapp.py     Flask API over the same functions the CLI calls
  web/          the GUI: index.html, app.css, app.js
platemaps/      example design files
tests/          pytest suite, including a synthetic 384-well export
```

The browser never re-implements any analysis: it posts the painted layout and
renders what `analysis.py` returns.

## Known limits

- Written against Applied Biosystems Excel exports (QuantStudio, 7500,
  StepOne). Bio-Rad CFX, Roche LightCycler and QIAGEN Rotor-Gene use different
  layouts and are not supported; adding one means adding its column spellings to
  `io.ALIASES` and its sheet names to `io.SHEETS`.
- Melt analysis uses the instrument's own Tm calls. Tm values reported for
  wells with no real product are noise picks, so treat `tm1` on an undetected
  well as meaningless.
- The standard curve is a plain least-squares fit of Ct on log10(quantity); it
  does not weight points or detect saturation, so check `n_flagged`.
- The GUI holds sessions in memory and binds to localhost. It is a desktop
  tool, not a server, and it is not built for concurrent users.

## Tests

```bash
pytest tests/
```

`tests/make_synthetic_384.py` builds a 384-well export that deliberately
differs from the reference file (longer preamble, `Cq` instead of `CT`,
`Detector Name` instead of `Target Name`) so the parser is exercised against
more than one dialect.

## License

See [LICENSE](LICENSE).
