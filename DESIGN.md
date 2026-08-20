---
name: QuantStudio Processing — Assay Signal Ledger
description: The Jensen Signal Ledger translated into a dense, local-first qPCR operating surface.
colors:
  paper: "#e7ecef"
  paper-alt: "#d8e0e5"
  surface: "#f2f5f6"
  ink: "#11191f"
  muted: "#4b5962"
  lapis: "#005a9c"
  lapis-deep: "#00477c"
  focus: "#c93425"
  flag: "#9d3d37"
rounded:
  interface: "0"
  domain-exceptions: "wells, spinner, status markers, switch"
---

# Design System: Assay Signal Ledger

## Relationship to jensen-l.com

The product belongs to the same Signal Ledger family as Jensen Luo's personal site: cool zinc paper, charcoal ink, mineral blue, square rules, a Yellowtail signature, a restrained Bricolage display face, and motion derived from real biological signal.

This is the Operate surface, not another editorial chapter. It does not inherit full-screen snapping, large display whitespace, or section entrance effects. Dense scientific state and familiar controls take priority. It does inherit the site's System / Light / Dark edition control and 800 ms edition change.

## Type

- Yellowtail appears only in the Jensen Luo brand link.
- Bricolage Grotesque appears only in the first-use “QuantStudio Processing” title.
- The system sans stack handles every workspace heading, control, dialog, result, and explanation.
- Monospace is reserved for well addresses, Ct values, filenames, runtime state, counts, and other measured data.

## Color and meaning

- Zinc paper is the application canvas; alternate paper separates the plate-design ledger.
- Lapis identifies primary actions, selection, and the first-use assay field.
- The eight dye tokens remain categorical data colors and must not be collapsed into the brand blue.
- Red is functional: focus, QC, errors, and destructive actions. It is never an ornamental accent or an assignment color.
- QC keeps both the red inset and hatch so color is not its only signal.
- The shell follows System, Light, or Dark. Opaque plots sit on fixed light evidence paper. Transparent curve previews composite directly against the current shell, matching the alpha in their exports.

## Composition

The first-use view pairs a five-column paper introduction with a seven-column lapis assay field. The field contains the real 96-well plate illustration and one acquisition sequence of qPCR amplification curves. The curves draw once, end at their exact static paths, and never loop.

After a workbook loads, the interface becomes a dense ruled workspace:

1. plate map and its compact status ledger;
2. Fields, Values, and Analysis in the alternate-paper design rail;
3. full-width sticky results and exports.

The 96/384 plate geometry, circular wells, row and column headers, horizontal pan, results tables, and plots are domain objects rather than decorative cards. They keep their working density.

## Interaction language

- Every link, enabled button, switch, well, and plate header responds within 90ms using opacity and one-pixel registration. Nothing lifts or gains a shadow.
- The three-position theme rail uses the same icons, state model, persisted preference, and edition timing as jensen-l.com.
- Hover changes border or ink contrast. Press, hover, selection, focus, pending, and disabled remain separate states.
- Focus uses a two-pixel vermilion outline. Lapis controls keep enough offset for the ring to remain visible.
- Plate wells use one roving tab stop and arrow-key navigation; empty wells are disabled.
- Row headers remain visible while a wide plate pans horizontally.
- Field choices use a button group with arrow-key navigation. Result choices retain the ARIA tabs pattern.
- Threshold controls are inert while collapsed; native text-field undo is never intercepted by plate undo.
- Pending delays, reserved button widths, hold-to-clear, undo, replace/leave guards, clear runtime recovery, and sticky results remain intact.

## Motion

Motion explains a state or relationship:

- qPCR curves register the assay on first use;
- shell themes change as one coordinated 800 ms edition, while the masthead remains visually anchored;
- the 96/384 plate shifts in the direction of the selected format;
- result panes follow result-tab direction;
- disclosures, dialogs, spinners, and runtime indicators communicate active work.

Fields, values, and ordinary content do not receive generic fade-up animation. Reduced motion removes acquisition and spatial transitions while leaving complete static evidence.

## Responsive rules

- Wide screens use a shared brand/runtime/theme masthead and a separate, ruled workbook-action row that only exists after load.
- Below 1280px, action spacing tightens without mixing workbook state into the brand row.
- Below 1120px, the design rail follows the plate in source order.
- Below 840px, the first-use halves stack and the plate status ledger returns below the plate.
- Below 680px, ordinary controls provide at least 44px targets; the plate remains horizontally scrollable rather than shrinking the wells.
- Below 370px, action grids and analysis pairs become one column.

## Guardrails

- Do not add a generic card grid, bento layout, gradient hero, glass, glow, or soft elevation.
- Do not reintroduce warm off-white plus jade as the product identity.
- Do not use Bricolage for ordinary workspace headings.
- Do not use proof or flag red for plate assignments.
- Do not replace circular wells or categorical dye colors with brand styling.
- Do not hide core Fields, Values, or Analysis controls in a new navigation shell.
- Do not theme opaque scientific evidence itself dark; transparent previews intentionally reveal the current shell instead of adding a backing surface.
- Do not sacrifice 96/384 density, sticky results, local-only guarantees, text status, keyboard operation, or reduced-motion fallback for visual consistency.
