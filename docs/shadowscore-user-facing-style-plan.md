# ShadowScore User-Facing Style Plan

This plan describes how to bring the server-hosted ShadowScore pages into the
same visual family as Smol while preserving each page's musical responsibility.
It is design guidance for implementation, not a request to change behavior.

## Source Reference

Use the Smol application as the nearest visual precedent for ShadowScore's
operator-facing browser tools.

Relevant Smol files:

- `/Users/mdavidson/Documents/Repos/Smol/style/style.css`
- `/Users/mdavidson/Documents/Repos/Smol/index.html`
- `/Users/mdavidson/Documents/Repos/Smol/js/theme.js`

The durable guidance from Smol is not a literal copy of component markup. The
durable guidance is that the UI should feel like a compact musical workbench:
dark, dense, readable, status-aware, and color-coded where color represents
musical or operational meaning.

## Design Principles

1. Treat ShadowScore as an instrument/control system.

   User-facing pages should feel closer to a performance workstation than a
   website. Prefer dense editor surfaces, stable controls, and live state over
   landing-page composition or explanatory cards.

2. Use shared product chrome.

   `/`, `/structure-editor`, `/event-list`, `/admin`, `/transport/status`, and
   any future server-hosted editor index should share a common token palette,
   top status treatment, control styling, and spacing rhythm.

3. Keep page ownership visible.

   Styling should reinforce the existing conceptual boundaries:

   - Structure Editor owns mesostructure, macrostructure, block assignment, and
     active section controls.
   - Event List owns canonical clip attributes and note-event editing.
   - Matrix Edit owns block-context grid editing for the selected player's
     assigned clip, with reference layers for other assigned clips.
   - Admin owns routing, hardware, saved scores, restore/reset, and resend
     operations.
   - Transport/status pages expose operational proof and diagnostics.

4. Use color as state, not decoration.

   Smol uses accent color to show activity, selected state, typed modules, and
   grouped controls. ShadowScore should use color for player identity, clip or
   block identity, routing state, playback state, warning, danger, and active
   selection. Page chrome should stay neutral enough that musical color remains
   legible.

5. Preserve performance readability.

   These pages may be used in a rehearsal or session. Prefer glanceable status,
   tabular numeric readouts, clear selected/active states, and predictable
   control placement over expressive visual novelty.

## Shared Tokens

Create a shared CSS token layer for server-hosted static pages, for example
`public/shared/shadowscore-style.css`.

Initial token direction:

```css
:root {
  color-scheme: dark;
  --ss-bg: #111821;
  --ss-panel: #17212c;
  --ss-surface: #263341;
  --ss-surface-soft: #324252;
  --ss-panel-strong: #3c4d5e;
  --ss-text: #d9e8ef;
  --ss-muted: #91a4b2;
  --ss-border: rgba(184, 210, 224, 0.12);
  --ss-border-strong: rgba(184, 210, 224, 0.2);
  --ss-accent: #8fec79;
  --ss-accent-strong: #50c878;
  --ss-accent-secondary: #69c7df;
  --ss-warn: #fbbf24;
  --ss-danger: #f87171;
  --ss-radius-ui: 8px;
  --ss-radius-control: 6px;
  --ss-font-ui: "Helvetica Neue", Helvetica, Arial, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

Notes:

- Default to the dark palette for editor/operator pages.
- Keep a light fallback only if a specific page needs it for print or external
  viewing.
- Keep radii at 6-8px. Do not introduce large rounded cards.
- Keep shadows subtle and reserve stronger glow/outline treatment for active
  or running state.

## Typography

Use the Smol type posture:

- UI font: `Helvetica Neue`, Helvetica, Arial, system UI fallback.
- Body/editor text: 13-14px.
- Labels: 11-12px, strong weight, muted color.
- Panel headings: 13-15px, strong weight, no oversized hero treatment.
- Status/readout values: tabular numerals where timing or counts are shown.
- Avoid negative letter spacing.
- Avoid all-caps headings except small labels where the compact workstation
  style benefits from them.

## Layout Grammar

Use a consistent page skeleton:

1. Top transport/status strip

   This strip should contain server URL/status, active block, playback state,
   relevant transport actions, and any page-specific save/revert status. It
   should feel like Smol's top transport panel: dark, compact, and always
   operational.

2. Secondary route or view tabs

   Use flat tabs with an accent underline for selected state. This can unify
   navigation across Structure Editor, Event List, Matrix Edit, Admin, and
   status pages.

3. Work area

   Prefer a three-zone workbench when the page needs it:

   - left rail: selection, blocks, clips, routes, devices, or pages
   - center: primary editor or table
   - right rail: inspector, details, diagnostics, or contextual actions

4. Responsive behavior

   On narrow screens, stack the work area with the primary editor first, then
   selection and inspector rails. Keep tabs horizontally scrollable rather than
   shrinking text until it becomes illegible.

## Controls

Apply common styling to `button`, `select`, `input`, `textarea`, table headers,
tabs, status chips, and panels.

Control behavior:

- Buttons: compact, bordered, 32-34px minimum height, strong text.
- Primary actions: green accent fill.
- Secondary actions: surface fill with accent hover border.
- Danger actions: no full red page chrome; use red text/border unless the
  action is destructive and confirmed.
- Disabled controls: visible but reduced opacity.
- Focus: clear outline using warning or accent color.
- Running/active state: green/cyan outline or subtle glow.
- Warning state: amber.
- Error/destructive state: red.

## Page Applications

### Root View Index

Reframe `/` as a compact dashboard/launcher rather than a landing page.

Recommended content:

- server/session status
- active block and macro playback status
- editor route list
- RNBO graph editor discovery
- hardware unit/routing summary if cheap to fetch

Avoid oversized title treatment. Route entries can still be card-like, but they
should read as operational tiles: dense, flat, and status-aware.

### Structure Editor

Structure Editor should be the clearest example of the workbench layout:

- left rail: blocks/sections
- center: selected block assignments and duration/scale controls
- right rail: song form, macro playback, and active block controls

Use player colors in assignment rows, but keep the surrounding panel neutral.
Active block and selected block must be visually distinct states.

### Event List

Event List should stay table-first and precise.

Recommended treatment:

- top strip: selected clip, dirty/save state, revision/stale state
- attribute row: compact, single-band form controls
- table: dark sticky header, clear row hover/focus, narrow numeric columns with
  tabular numerals
- paste/import: secondary collapsible or lower-priority panel

Do not make Event List look like Matrix Edit. It is the canonical clip editor,
so precision and auditability matter more than spatial musical visualization.

### Matrix Edit

Matrix Edit source lives outside this repo and exports into
`public/matrix-edit`. Do not hand-edit the bundled output for durable styling.

Apply this plan by changing Matrix Edit source first, then exporting into
ShadowScore. Keep Matrix Edit visually related through shared tokens and chrome,
but preserve the grid's own interaction language.

Design emphasis:

- strong active block/player/clip context
- reference layers differentiated from editable material
- minimal upper-area controls
- transport state read from server-owned playback state, not stale local cache

### Admin

Admin should feel like an operations console.

Recommended treatment:

- left or top grouping for hardware units and routing
- clear target identity cards/rows
- saved score controls separated from live routing controls
- destructive reset/restore actions visually contained and confirmation-heavy
- live proof surfaces, such as `/hardware/units` and `/rnbo/targets`, presented
  in readable diagnostic panels

### Transport Status

Transport/status pages should be proof-oriented, not decorative.

Recommended treatment:

- prominent current transport facade state
- JACK/Link/beat-witness state as structured readouts
- active macro block and next-advance timing
- RNBO target write status
- raw JSON only as an expandable diagnostic, not the primary view

## What Not To Copy Literally

- Do not copy Smol's module palette into ShadowScore pages. ShadowScore pages
  are score/control editors, not patch construction tools.
- Do not use color-coded module type chips unless the page has a comparable
  typed-object vocabulary.
- Do not make every panel dark-on-dark if the actual content, such as player
  colors or dense tables, loses contrast.
- Do not add a marketing hero or decorative illustration to the root page.
- Do not flatten page responsibilities just to make every view look identical.
  The common style should clarify ownership, not erase it.

## Implementation Phases

1. Shared static style foundation

   Add `public/shared/shadowscore-style.css` with tokens, base typography,
   controls, panels, tabs, status strips, tables, and responsive helpers.

2. Root view index

   Convert `/` to the shared style and make it a compact dashboard/launcher.
   This is the lowest-risk visible proof of the new visual language.

3. Structure Editor and Event List

   Move their inline styles toward shared classes and tokens while preserving
   behavior. Keep page-specific layout rules local only where necessary.

4. Admin and transport/status surfaces

   Apply the shared operational console treatment and make diagnostic state
   easier to scan.

5. Matrix Edit source alignment

   Update the Matrix Edit source repository, run its tests/build, export into
   `public/matrix-edit`, and verify `public/matrix-edit/build-info.json` shows
   the committed Matrix Edit SHA with `matrixeditDirty: false`.

6. Optional editor registry polish

   If `/editors/*` instrument editors become first-class routes, list them from
   the same root dashboard while allowing each instrument editor to keep its own
   archetype-specific UI language.

## Verification Checklist

For each migrated page:

- Desktop layout has no overlapping controls at common widths.
- Mobile/narrow layout stacks in a usable order.
- Text fits inside buttons, tabs, route tiles, and table headers.
- Focus states are visible from keyboard navigation.
- Active, selected, dirty, stale, running, warning, and danger states are
  visually distinguishable.
- Player colors remain legible against the dark neutral chrome.
- Status text reports the same live state as the underlying route/API.
- The page still works from the served static route, not only by opening the
  file directly.

For live-host verification:

- Check `/`, `/structure-editor`, `/event-list`, `/admin`, and
  `/transport/status` on the target host.
- If Matrix Edit changes are included, verify `/matrix-edit` on the target host
  after source export and server deploy.
- Compare the visible active block/playback status with `/score`,
  `/structure/playhead`, and `/macrostructure/playback` when relevant.

## Open Questions

- Should the shared CSS live as a plain static stylesheet, or should any
  imported/bundled editor source consume the same tokens through its own build?
- Should the root dashboard fetch hardware/routing state by default, or keep
  that behind an explicit refresh to avoid slow startup on weak networks?
- Should dark mode be mandatory for all operator pages, or should a future
  theme toggle exist for bright rehearsal spaces?
