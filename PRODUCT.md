# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Researchers and laboratory staff working with qPCR exports from Applied Biosystems QuantStudio, 7500, and StepOne software. They use the browser workspace while reviewing an experiment, reconstructing or correcting its plate layout, checking quality, and preparing results for downstream analysis or record keeping.

## Product Purpose

QuantStudio_Processing turns awkward instrument `.xlsx` exports into tidy per-well data, replicate summaries, QC flags, plots, processed workbooks, and reusable plate maps. Success means a researcher can move from a raw export to an auditable result without manually cleaning spreadsheets or sending experimental data to a server.

## Positioning

The hosted workspace runs the existing Python analysis stack inside a dedicated Pyodide worker in the browser. The workbook remains on the user's device while the same local-first analysis logic powers plate annotation, QC, plotting, and export.

## Operating Context

- The primary workflow is desktop research work with dense 96- or 384-well plate layouts.
- Users drop or choose a QuantStudio-family `.xlsx`, optionally fill the plate from its Sample Setup, paint fields and values, select analysis groupings, run analysis, inspect result tables and curves, and export the result.
- Row and column headers support whole-line painting; drag paints wells; Alt-drag erases; Command-Z or Control-Z undoes.
- Generated artifacts include a processed `.xlsx`, platemap YAML, individual PNG or SVG plots, and a ZIP of PNG plots.

## Capabilities and Constraints

- The hosted interface accepts `.xlsx`, not legacy `.xls`.
- Browser plate editing supports 96- and 384-well formats; the analysis core also handles other plate sizes outside this UI.
- Empty wells from the export cannot be painted.
- The first visit downloads Pyodide and scientific packages; plotting is loaded when analysis first needs it.
- A reload clears workbook and analysis state from browser memory.
- Analysis and downloads must remain independent of an HTTP analysis API.
- Dense data and scientific terminology take priority over decorative presentation.

## Brand Commitments

- Keep the product name `QuantStudio_Processing` and its connection to Jensen Luo's research-software work.
- The interface should belong to the same recognizable family as [jensen-l.com](https://jensen-l.com): direct, human, technically careful, and quiet enough for real work.
- [desengs.com](https://desengs.com) is a binding craft reference for disciplined density, precise line work, and interface details, not a template to copy literally.
- Avoid generic AI-generated SaaS styling, ornamental card grids, inflated helper copy, and visual effects that obscure the task.

## Evidence on Hand

- The implemented browser workflow and copy live in `quantstudio_processing/web/`.
- `tests/synthetic_384.xlsx` exercises a complete 384-well workflow.
- `tests/test_browser.py` and `tests/test_quantstudio_processing.py` cover parsing, browser-session state, exports, and frontend wiring.
- The README documents the workflow, QC behavior, local-only architecture, deployment, and supported outputs.
- No customer claims, benchmarks, testimonials, or clinical-use claims are established and none should be invented.

## Product Principles

1. Experimental data stays local and that boundary remains explicit.
2. Scientific state is legible: assignments, missing data, QC flags, and processing status never rely on decoration alone.
3. Fast, familiar controls keep attention on the plate and results rather than the interface.
4. Every generated artifact should be inspectable, reusable, and named predictably.
5. The browser experience and Python analysis must continue to agree on terminology and output.

## Accessibility & Inclusion

Keyboard operation, visible focus, semantic status updates, sufficient contrast, reduced-motion support, and usable touch targets on narrow screens are required. Color must not be the only signal for selection, status, or QC.
