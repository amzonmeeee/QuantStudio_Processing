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

Nothing in the analysis core is hard-coded to a plate layout. Plate size (96 /
384 / 1536), which column identifies an assay and which identifies a replicate
group are all either detected or passed in. The browser GUI supports 96- and
384-well layouts, using the file's layout as a starting point you can overwrite.

## Install

```bash
git clone https://github.com/amzonmeeee/QuantStudio_Processing
cd QuantStudio_Processing
pip install -e .
```

## The GUI

Use the hosted app at **[qpcr.jensen-l.com](https://qpcr.jensen-l.com/)**, or
run it locally:

```bash
qsp gui                 # opens http://127.0.0.1:8765
```

Drop an export on the page. The plate fills in from the file's own Sample Setup
so you have something to work from, and from there:

- **Fields** are the columns you want in the results — `assay`, `sample`,
  `quantity`, or anything else you name. Add them in place, double-click to
  rename, or use the remove control that appears on hover.
- **Values** are what a field can be. Pick one, then drag across the plate.
  Values use the same add, double-click-to-rename, and remove pattern. Row and
  column headers paint a whole line; alt-drag erases; ⌘Z / Ctrl+Z undoes.
- **Right-click** a well, row, or column to edit every plate-map field for that
  scope at once. Instrument Ct values and QC results remain read-only.
- **Fill from file** re-imports the export's own layout, and **Hold to clear
  plate** throws yours away. Both are undoable.
- **96 / 384** switches the grid independently of what the file says, so an
  export that only used part of a plate can still be laid out the way you ran it.
- **Copy platemap** puts the painted layout on the clipboard as the same YAML
  the CLI reads, so a layout designed in the GUI becomes a file you can commit.
- **Download workbook** gives you the processed `.xlsx`.
- **Curves** lets you download each generated plot as a PNG or editable vector
  SVG, or package all available PNG or SVG plots into separate ZIP archives.
  Curve backgrounds are transparent by default; the Analysis panel can switch
  amplification and melt exports to white without changing the plate heatmap.

Wells with no data in the export are drawn recessed and can't be painted; the
status line says how many were skipped.

The hosted interface accepts `.xlsx` exports only. Analysis runs in a dedicated
Python worker inside your browser: the workbook is never uploaded, and a reload
clears it from memory. Once a workbook is open, the interface warns before a
link, reload, back navigation, or tab close can discard that local session. On
the first visit the browser downloads Pyodide
v314.0.3 and its scientific packages; plotting is downloaded only when an
analysis first needs it. Bricolage Grotesque and the Yellowtail wordmark are
self-hosted with their license files, matching jensen-l.com without a
third-party font request; measurements and tabular data use the browser's
native monospace stack.

## Deploy to Cloudflare Workers

The hosted app is a static Cloudflare Worker deployment. Cloudflare serves the
HTML, JavaScript and Python source; Pyodide performs workbook parsing, QC,
plotting and `.xlsx` generation locally in the browser. There is no Flask API,
server-side session or workbook upload in this deployment.

### Automatic deploys from GitHub

Like the Personal Website repository, automatic deployment is provided by
Cloudflare Workers Builds rather than a GitHub Actions workflow. Connecting a
repository is a one-time dashboard setting; adding `wrangler.jsonc` alone does
not create that connection.

In **Cloudflare Dashboard → Workers & Pages** either import this repository as a
new Worker, or open the existing `quantstudio-processing` Worker and choose
**Settings → Builds → Connect**. Use these settings:

| setting | value |
|---|---|
| Repository | `amzonmeeee/QuantStudio_Processing` |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Non-production deploy command | `npx wrangler versions upload` |

The Cloudflare Worker name must be `quantstudio-processing`, matching
`wrangler.jsonc`. Select **Save and Deploy** once; every later push to `main`
will then build and promote a new production deployment. See Cloudflare's
[Workers Builds guide](https://developers.cloudflare.com/workers/ci-cd/builds/)
for the dashboard flow.

For a manual deployment or local preview:

```bash
npm install
npm run build             # creates the ignored dist/ directory
npx wrangler login        # once per machine
npm run deploy
npm run dev               # local Cloudflare preview
```

Wrangler invokes `scripts/build_web.py` before previewing or deploying; the
build copies only the browser assets and analysis modules, rejects missing
inputs and enforces Cloudflare's 25 MiB per-asset limit.

The runtime is pinned to Pyodide v314.0.3 from jsDelivr. Pyodide supplies NumPy,
pandas, Matplotlib and PyYAML, while `openpyxl==3.1.5` is installed with
`micropip` from PyPI. A first run therefore needs network access and may take a
little while; browsers normally cache these immutable downloads for subsequent
visits. The app's content-security policy permits only those package hosts in
addition to the deployed origin.

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
| `--curve-background` | give amplification and melt exports a white background (default transparent) |
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
                  facet_by="assay", colour_by="sample", background=False)
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

## Project layout

```
quantstudio_processing/
  io.py         reading exports: sheet lookup, header detection, column aliases
  platemap.py   design files and well-range shorthand, both directions
  analysis.py   Ct handling, QC flags, replicate summaries, standard curve, dCt
  plot.py       amplification and melt curves, plate heatmap
  browser.py    JSON/bytes bridge used by the in-browser Python runtime
  webcore.py    framework-independent GUI analysis and workbook orchestration
  cli.py        `qsp` and `qsp gui`
  webapp.py     local Flask host for the GUI
  web/          the GUI, Pyodide worker and Cloudflare response headers
scripts/
  build_web.py  assembles and validates dist/ for Cloudflare Static Assets
platemaps/      example design files
tests/          pytest suite, including a synthetic 384-well export
```

The browser never re-implements any analysis in JavaScript: it passes the
painted layout to the same Python modules in Pyodide and renders what
`analysis.py` returns.

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
- The browser GUI keeps the current workbook and results only in that tab's
  memory. Reloading or closing the tab clears them; large workbooks are bounded
  by the memory available to the browser.

## Tests

```bash
pytest tests/
```

`tests/make_synthetic_384.py` builds a 384-well export that deliberately
differs from the reference file (longer preamble, `Cq` instead of `CT`,
`Detector Name` instead of `Target Name`) so the parser is exercised against
more than one dialect.

## License

See [LICENSE](LICENSE.txt).
