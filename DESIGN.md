---
name: Desky
description: One custody form, printed twice — the client keeps the white original, the operator works on the carbon copy.
colors:
  # Paper stock — the client's original (`:root` default, `[data-stock='paper']`)
  paper-stock: "#f4f1ea"
  paper-stock-sunk: "#eae6dc"
  paper-stock-raised: "#fffefb"
  paper-ink-strong: "#17150f"
  paper-ink: "#35322a"
  paper-ink-muted: "#5f5a4e"
  paper-ink-faint: "#8d8879"
  paper-rule: "#d9d3c5"
  paper-rule-strong: "#bdb6a5"
  paper-seal: "#a8321e"
  paper-field: "#fffefb"
  paper-field-border: "#c6c0b0"
  # Carbon stock — the operator's copy (`[data-stock='carbon']`)
  carbon-stock: "#14130f"
  carbon-stock-sunk: "#0d0c09"
  carbon-stock-raised: "#1d1c16"
  carbon-ink-strong: "#efeadc"
  carbon-ink: "#c7c1b0"
  carbon-ink-muted: "#948e7c"
  carbon-ink-faint: "#6b6659"
  carbon-rule: "#2c2a23"
  carbon-rule-strong: "#423f35"
  carbon-seal: "#e2664a"
  carbon-field: "#100f0c"
  carbon-field-border: "#3a372e"
  # Stock-independent
  on-seal: "#ffffff"
  screen-void: "#000000"
  # The mark. Belongs to neither stock: the icon is the same object on a
  # client's Dock, an operator's browser tab and the install page, so it
  # cannot take its colour from the paper it happens to be printed on.
  mark-ground: "#212120"
  mark-letter: "#e0a03a"
  mark-cursor: "#ffffff"
typography:
  display:
    fontFamily: "PT Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "2.5rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.04em"
    fontFeature: "'tnum' 1"
  display-entry:
    fontFamily: "PT Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "clamp(2rem, 5.5vw, 2.875rem)"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.06em"
    fontFeature: "'tnum' 1"
  password:
    fontFamily: "PT Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "0.28em"
  password-entry:
    fontFamily: "PT Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "clamp(1.5rem, 3.5vw, 1.875rem)"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.34em"
  title:
    fontFamily: "Golos Text, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
  lead:
    fontFamily: "Golos Text, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Golos Text, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "Golos Text, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Golos Text, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    letterSpacing: "0.08em"
  wordmark:
    fontFamily: "Golos Text, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    letterSpacing: "0.16em"
  data:
    fontFamily: "PT Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontWeight: 400
    fontFeature: "'tnum' 1"
rounded:
  none: "0"
  fine: "2px"
  base: "3px"
  thumb: "6px"
  dot: "50%"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.5rem"
  "6": "2rem"
  "7": "3rem"
components:
  button:
    backgroundColor: "{colors.paper-field}"
    textColor: "{colors.paper-ink-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "0.5rem 0.875rem"
  button-primary:
    backgroundColor: "{colors.paper-ink-strong}"
    textColor: "{colors.paper-stock}"
    rounded: "{rounded.base}"
    padding: "0.5rem 0.875rem"
  button-primary-hover:
    backgroundColor: "{colors.paper-ink}"
    textColor: "{colors.paper-stock}"
  button-seal:
    backgroundColor: "{colors.paper-seal}"
    textColor: "{colors.on-seal}"
    rounded: "{rounded.base}"
    padding: "0.5rem 0.875rem"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.paper-ink-muted}"
    rounded: "{rounded.base}"
    padding: "0.5rem 0.875rem"
  button-quiet-hover:
    backgroundColor: "{colors.paper-stock-sunk}"
    textColor: "{colors.paper-ink-strong}"
  button-lg:
    typography: "{typography.lead}"
    padding: "0.8125rem 1.25rem"
  button-icon:
    padding: "0.4375rem"
    size: "18px"
  input:
    backgroundColor: "{colors.paper-field}"
    textColor: "{colors.paper-ink-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.base}"
    padding: "0.5rem 0.625rem"
    width: "100%"
  cells:
    backgroundColor: "transparent"
    textColor: "{colors.paper-ink-strong}"
    typography: "{typography.display-entry}"
    rounded: "{rounded.none}"
    padding: "0.5rem 0"
    width: "100%"
  field-row:
    backgroundColor: "transparent"
    textColor: "{colors.paper-ink-strong}"
    typography: "{typography.small}"
    rounded: "{rounded.none}"
    padding: "0.4375rem 0"
  notice-quiet:
    backgroundColor: "{colors.paper-stock-sunk}"
    textColor: "{colors.paper-ink-strong}"
    typography: "{typography.small}"
    rounded: "{rounded.none}"
    padding: "0.75rem"
  popover:
    backgroundColor: "{colors.paper-stock-raised}"
    textColor: "{colors.paper-ink-strong}"
    rounded: "{rounded.base}"
    padding: "0.5rem"
    width: "14rem"
  popover-item:
    backgroundColor: "transparent"
    textColor: "{colors.paper-ink-strong}"
    typography: "{typography.small}"
    rounded: "{rounded.fine}"
    padding: "0.4375rem 0.5rem"
  custody-band:
    backgroundColor: "{colors.paper-seal}"
    textColor: "{colors.on-seal}"
    rounded: "{rounded.none}"
    padding: "0.75rem 1.5rem"
---

# Design System: Desky

## Overview

**Creative North Star: "The Carbon-Copy Custody Form"**

A session here is a transfer of custody, and the interface is the form that records it — printed twice, on two grades of stock. The client keeps the white original; the operator works on the carbon copy. Everything that carries meaning is the same on both sheets: the same ink roles, the same type, the same ruled fields, the same state words. Only the paper differs. That is why there is one shared stylesheet with two stock definitions rather than two themes, and why a screenshot of either surface is recognisably the same document.

The mode is **Operate**, not Explore. Nothing about the affordances is novel: buttons look like buttons, text fields look like text fields, a menu opens under the control that summoned it, and the thing that ends the session is a large control with a power icon on it. Familiarity is a feature in a tool people meet once, mid-problem, or use for an hour while thinking about something else. The invention is spent entirely on material, palette, type, spacing, and the state vocabulary — never on the affordances themselves.

There are no cards and no shadows anywhere in the system. Structure comes from ruled fields — a printed label above a hairline, with the value in the field below — and from the space between them. That single motif is what lets the operator's session view contain exactly one lit object (the client's screen) and lets the client's panel put one nine-digit number above everything else without a box around it. The dark and light split is not a preference toggle dressed as a design decision: carbon is derived from an operator staring for an hour at a bright rectangle that is someone else's screen, and paper is derived from a client glancing at a corner of their own bright desktop to confirm that what they allowed is still what is happening.

**Key Characteristics:**
- One ink palette, two stocks; the mark never changes colour, only the paper
- No cards, no shadows, no gradients — hairline rules and stock planes do all the structural work
- Seal red under a single-meaning law: control of this machine is released to someone else
- Every measured value in PT Mono with tabular figures, in a fixed character cell
- Motion is sheet feed: 150ms, linear, state-change only — nothing pulses, breathes, or eases
- Interface copy is entirely Russian; both faces are self-hosted with Cyrillic subsets

## Colors

One ink palette in five weights, printed onto two stocks; the accent is a single reserved red that means one thing and is never spent on anything else.

### Primary

- **Seal Red** (paper `#a8321e`, carbon `#e2664a`): the only chromatic ink in the system. It marks the live-session band at the top of the client's panel, the 4px frame drawn around the client's entire screen, the tag pinned above the menu bar, and the control that ends the session. It also carries the caret, the text selection, and the focus ring — the places where the interface is showing you where control currently sits. The two values are the same pigment on different stock: ink transfers lighter onto carbon than it prints on the original, and both clear 4.5:1 against their own stock.

### Neutral

Paper stock (the client's original, and the console's optional light setting):

- **Rag Paper** (`#f4f1ea`): the page itself. Warm, slightly yellow-grey, deliberately not white.
- **Sunk Paper** (`#eae6dc`): pressed-in surfaces — a button held down, a hovered menu row, and every notice on both surfaces.
- **Raised Paper** (`#fffefb`): the field ground and popover surface, the one plane brighter than the page.
- **Printed Ink** (`#35322a`) and **Heavy Ink** (`#17150f`): body text and headings; heavy ink is also the primary button's fill.
- **Muted Ink** (`#5f5a4e`) and **Faint Ink** (`#8d8879`): labels and secondary copy, then timestamps, placeholders and disabled marks.
- **Hairline** (`#d9d3c5`) and **Strong Hairline** (`#bdb6a5`): the two rule weights that replace every border-box in the system.
- **Field Edge** (`#c6c0b0`): the stroke around inputs and resting buttons.

Carbon stock (the operator's copy, and the console default):

- **Carbon Sheet** (`#14130f`), **Sunk Carbon** (`#0d0c09`), **Raised Carbon** (`#1d1c16`): the same three planes, inverted.
- **Transferred Ink** (`#c7c1b0`), **Heavy Transfer** (`#efeadc`), **Muted Transfer** (`#948e7c`), **Faint Transfer** (`#6b6659`): the same four ink weights, reversed in luminance and held off pure white so nothing glares beside the client's screen.
- **Carbon Hairline** (`#2c2a23`) and **Strong Carbon Hairline** (`#423f35`), **Carbon Field** (`#100f0c`), **Carbon Field Edge** (`#3a372e`), **Carbon Seal Wash** (`#2a1712`): the corresponding rules, fields and washes.

Stock-independent:

- **Mark White** (`#ffffff`): text and icons sitting on seal red. It is not a surface colour; nothing in this system is ever a white box.
- **Screen Void** (`#000000`): the letterbox behind the client's video in the operator's session view. It exists so the remote screen has an edge, not as a neutral in the palette.

### Named Rules

**The Stock Rule.** Colour is the stock, never the mark. Both surfaces use identical ink roles and identical type; only the paper changes. Never introduce a colour that exists on one stock and not the other, and never let a component pick its own background outside the three stock planes.

**The Seal Rule.** Seal red is reserved by law for exactly one meaning: control of this machine is currently released to someone else. It is never an error colour, never a hover state, never a brand flourish, never a chart colour, never decoration. A screen with no live session has no seal red on it except the caret and the focus ring.

**The Ink-Weight Rule.** Hierarchy is carried by the four ink weights, not by size or colour tints. If something needs to recede, it moves from ink to muted to faint — it does not become a lighter shade of the accent.

## Typography

**Display Font:** PT Mono (with `ui-monospace`, `SF Mono`, Menlo, Consolas fallbacks) — self-hosted, Cyrillic and Latin subsets
**Body Font:** Golos Text (with `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, Roboto fallbacks) — self-hosted, variable weight 400–700, Cyrillic and Latin subsets
**Label/Mono Font:** PT Mono, at label sizes, for every measured value

**Character:** Golos Text is a plain, wide-apertured Russian grotesque built for interfaces — no personality to get in the way of a person reading under mild stress. PT Mono is its measurement instrument: a fixed-advance face used strictly where a number is being read aloud, timed, or compared. The pairing says "official form", not "developer tool"; the mono is a register, not a texture.

### Hierarchy

- **Display** (PT Mono 400, 2.5rem/40px, line-height 1.1, tracking 0.04em): the nine-digit machine number on the client's panel, and the eight-character password, set in two runs of four, beneath it at 1.75rem/28px with 0.28em tracking. These are the largest things on their screen. Nothing competes with them.
- **Display Entry** (PT Mono 400, `clamp(2rem, 5.5vw, 2.875rem)`, tracking 0.06em): the same two values as the operator types them — the number field on the console, above the password field at `clamp(1.5rem, 3.5vw, 1.875rem)` with 0.34em tracking and uppercase. The password field is width-locked to `calc(9ch + 9 * 0.34em)` — eight characters and the space they are grouped by — so the last character is not clipped by its own trailing letter-space.
- **Title** (Golos Text 600, 1.375rem/22px, line-height 1.25, balanced wrap): the single `h1` on any view — "Permissions needed", "Connection closed".
- **Lead** (Golos Text 600, 1.0625rem/17px, line-height 1.25): `h2`, the large-button label, and the running session clock on the client's live band.
- **Body** (Golos Text 400, 0.9375rem/15px, line-height 1.5): the base size for the whole system. Measures are capped by role — 68ch for a paragraph, 52ch for waiting copy, 46ch for panel body text, 42ch for the note beside the primary action, 40ch for a popover note.
- **Small** (Golos Text 400, 0.8125rem/13px): field rows, feed entries, popover items, secondary copy. This is the workhorse size on both surfaces.
- **Label** (Golos Text 500, 0.6875rem/11px, tracking 0.08em, uppercase, muted ink): the printed label above every ruled field and above every entry. The wordmark is the same face at 0.8125rem with 0.16em tracking; toolbar readout labels use 0.07em and the live-session band 0.1em.

The scale is fixed steps, not fluid: 0.6875 / 0.8125 / 0.9375 / 1.0625 / 1.375 / 2rem. `clamp()` appears only on the two credential entry fields on the console, where the value must fill the sheet.

### Named Rules

**The Read-Aloud Rule.** Any value that gets spoken over a phone, ticks, or is compared against another value is set in PT Mono with `font-variant-numeric: tabular-nums` and `font-feature-settings: 'tnum' 1`, inside a fixed character cell (the toolbar readouts are `min-width: 5.5ch`). A running timer or a moving latency figure must never nudge what sits beside it.

**The Fixed-Step Rule.** The shared type scale does not clamp. A heading that shrinks inside a 460px panel reads worse than one that simply reflows onto a second line, so narrow layouts change structure and never type size.

**The Cyrillic-First Rule.** All interface copy is Russian, and both faces ship self-hosted with the Cyrillic subset loaded first. Never introduce a face without Cyrillic coverage, and never set a Russian label in a tracking so tight that its descenders and Cyrillic breves collide.

## Layout

The whole system is sheets and rules. There is no grid framework, no container class, and no spacing utility — spacing comes from a seven-step rem scale (0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 / 3rem) applied directly to a handful of CSS grid and flex containers.

**The operator console** is one printed sheet on carbon stock. A masthead (padding 1rem × 2rem, hairline underneath) carries the wordmark on the left and the server state plus the stock toggle on the right. Below it the sheet is `min(1080px, 100%)`, centred, in two columns at `minmax(0, 1.45fr) minmax(0, 1fr)` with a 3rem gutter: the entry form on the left, the custody chain on the right behind a left hairline. Vertical padding is `clamp(1.5rem, 6vh, 3rem)` at the top, and the sheet is optically centred in the space below the masthead rather than pinned to the top, where it read as a page that had not finished loading. The primary control sits at the foot of the form above a hairline, where a signature goes on a form.

**The session view** is the inverse: no page at all. The client's video fills the viewport (`object-fit: contain` on a black ground, native cursor hidden), a translucent toolbar is pinned to the top edge at `z-index: 20`, and popovers escape it at `z-index: 40` with `position: fixed`. The toolbar retracts to `translateY(calc(-100% + 8px))` leaving an 8px lip, with a 12px grip strip hanging below its lower edge as the reach target. Connection-stage messaging appears as a centred overlay at 18% from the bottom, `pointer-events: none`, so it never blocks the screen it is describing.

**The client's panel** is a 460 × 640 window (minimum 420 × 560) with a hidden-inset title bar and a 28px draggable strip along its top. Its body is a column: a padded content region (0.5rem top, 1.5rem sides and bottom, 0.75rem between blocks), and a foot pushed to the bottom by `margin-top: auto` behind a top hairline, holding the state line or the control that ends the session. Content scrolls; the foot does not.

**The session frame** is a full-display, click-through, always-on-top window: a 4px seal border at `inset: 0` and a tag pinned to the top edge, horizontally centred, above the menu bar — where macOS puts system status — leaving the Dock uncovered.

**Responsive behaviour** is structural, in two steps. At 900px the console sheet collapses to one column and the custody chain's left hairline becomes a top hairline; the split entry row stacks. At 720px the toolbar sheds readouts from the third onward rather than shrinking them, and the host name's ellipsis clamp tightens from 22ch to 14ch.

### Named Rules

**The Ruled-Field Rule.** Structure is a printed label above a hairline with the value in the field below it. Rows sit in a baseline-aligned flex pair with the label left and the value right, 0.4375rem of vertical padding, and a hairline underneath that is dropped on the last row. This replaces the card everywhere. If a new block needs visual containment, it gets a rule and a label, not a box.

**The Structural Reflow Rule.** Narrow layouts change what is shown and how it is stacked — never what size it is set at. Drop a column, drop a readout, flip a left rule to a top rule. Do not scale type down to fit.

## Elevation & Depth

The system has **no shadows at all** — not one `box-shadow` in any stylesheet, and no gradients, glows, or borders drawn to fake a lift. Depth is entirely tonal and structural, built from three things: the three stock planes (sunk / page / raised), the two hairline weights, and stacking order. A popover reads as "above" because it is on raised stock inside a strong hairline; a pressed button reads as "in" because it drops to sunk stock; a field reads as a place you can write because it is the raised plane inside a field-edge stroke. Nothing lifts off the page, because the page is a sheet of paper and paper does not lift.

The one exception is a legibility mechanism rather than a finish: the session toolbar floats over arbitrary remote pixels and uses `background: color-mix(in srgb, var(--stock) 86%, transparent)` with `backdrop-filter: blur(18px) saturate(1.2)`. Without it the readouts become unreadable the moment the client opens a light window. It is the only blur in the system and the only translucent surface.

### Named Rules

**The No-Card Rule.** Nothing in this system is a box with a shadow. If a component seems to need a card, it needs a rule and a label instead.

**The Blur-Is-Legibility Rule.** Backdrop blur is permitted only where the interface sits over content it does not control. It is never applied to a surface that has a known background behind it.

## Shapes

Corners are effectively absent. The only radius token is 3px, and it applies to exactly three things: buttons, inputs, and the popover shell. Popover rows use the same 3px. Everything with structural meaning is square: the credential fields, ruled fields, notices, the live-session band, the session frame, and the toolbar. Scrollbar thumbs are 6px with a 3px stock-coloured border that reads as inset padding, so the thumb sits inside the gutter rather than filling it.

Strokes come in three weights and they are meaningful. A 1px hairline separates rows and sections. A 1.5px strong hairline underlines a credential entry field, which is drawn as a bottom rule only — no box, no radius, no fill — so the number sits on a line like a value written onto a form. A 4px seal band draws the session frame, with a 1px `rgba(255,255,255,0.28)` hairline just inside it: against a dark or busy desktop a single flat rule reads as a wallpaper edge, and two weights read as something drawn on top of the screen.

Small marks carry state by shape, not only by colour. The state marker is a 6px circle by default; the warning state turns it into a 7px square rotated 45°. The live marker on the client's panel is a 10px square that holds perfectly still. Icons are a single stroked set at 18px, 1.5px stroke, round caps and joins, inlined as an SVG symbol sprite per surface.

### Named Rules

**The Shape-Carries-State Rule.** A state marker changes shape when it changes meaning. Colour alone never distinguishes one state from another, and the measured value is always printed beside the state name.

**The Two-Weight Frame Rule.** Anything drawn on top of a screen the interface does not own gets two stroke weights — a band and a hairline. One weight reads as part of the wallpaper.

## Components

Both surfaces share a single component sheet, so the client's giant "end it" control and the operator's toolbar button are literally the same component at different scales. A support tool where the same action looks different in two places is a tool people misread under stress.

### Buttons

- **Shape:** barely-softened corners (3px), 1px field-edge stroke, no shadow.
- **Default:** raised-stock fill, heavy ink label, 0.5rem × 0.875rem padding, weight 500, `line-height: 1.2`, icon and label in a flex row with 0.5rem between them.
- **Primary:** solid heavy ink with the stock colour as the label — the darkest thing on a paper sheet, the lightest thing on a carbon one. Hover moves the fill from heavy ink to printed ink; active holds there.
- **Seal:** solid seal red with white label, used for exactly two controls in the product — "End the session" on the client's panel and "Disconnect" in the operator's toolbar. Hover is `filter: brightness(1.08)`; nothing else.
- **Quiet:** transparent fill and border, muted ink label; on hover it takes sunk stock and heavy ink. This is the toolbar's default register.
- **Large:** 0.8125rem × 1.25rem padding at lead size; combined with `width: 100%` for the client's decision controls.
- **Icon-only:** square padding (0.4375rem on the console, 0.375rem on the panel) around an 18px stroked glyph, always with a `title` and `aria-label`.
- **Hover / Focus:** hover shifts the border to faint ink and never changes the fill on the default variant. Focus is a global 2px seal outline at 2px offset — the same ring on every surface, never removed.
- **Disabled:** `filter: grayscale(1)` with `opacity: 0.45`. Genuinely desaturated, not merely dimmed: an unavailable control should look unavailable rather than look like it is loading.

### Inputs / Fields

- **Style:** raised-stock fill inside a 1px field-edge stroke at 3px radius, 0.5rem × 0.625rem padding, inheriting the body face and size. Placeholders are faint ink.
- **Credential entry (`.cells`):** the exception, and the signature input of the system. No box and no fill — a transparent field with a 1.5px strong-hairline bottom rule, set in PT Mono with tabular figures at display-entry size. The number is set larger than the product name and larger than any label, so reading it aloud digit by digit matches what the eye sees.
- **Focus:** the bottom rule (or the border, on a boxed input) turns seal red. There is no glow, no fill change, and no border-width change that would shift layout.
- **Error:** errors are announced by a notice block, never by recolouring the field.

### Ruled Fields

- **Style:** a label-and-value pair on a shared baseline, label in small muted ink on the left, value in heavy ink right-aligned, 0.4375rem vertical padding, 1px hairline below, hairline dropped on the last row. Values that are measurements carry the data class.
- **Use:** the client's live session facts, the incoming-request facts, and the operator's end-of-session summary all use the same row.

### Navigation

There is no persistent navigation. The console is a masthead plus a view swap (`connect` / `waiting` / `session` / `ended`); the panel is a bare view swap between `permissions`, `ready`, `request`, `session`, and `settings`. The only global controls are the stock toggle in the console masthead, and "Settings" in the panel's foot — both quiet buttons.

- **Session toolbar:** a translucent, blurred bar at the top of the session view, in three zones — identity (host name clamped by ellipsis, session code beneath it in mono micro), readouts, then actions pushed right by `margin-left: auto`. It retracts to an 8px lip with a 150ms linear transform, and has a 12px invisible grip below it.
- **Popover menus:** raised stock inside a strong hairline at 3px radius, minimum 14rem (24rem for the clipboard sheet), rows at small size with the label left and a faint-ink hint right. The selected row goes weight 600 and gains a single seal-red middot after it. Fixed positioning so they escape the toolbar rather than being clipped by it.

### State Marker

The system's one status vocabulary, rendered identically on both surfaces: a 6px mark in `currentColor` followed by the state name at small size, with the measured value always printed beside it. Three states, each a different shape as well as a different weight — `state-ok` a solid disc in body ink, `state-idle` a hollow ring in faint ink, `state-warn` a 7px rotated square in heavy ink. Shape carries the meaning because a set of marks separated only by colour is unreadable to anyone who cannot separate those colours, and because "settled" and "still working on it" must never look alike. Seal red is absent from this vocabulary on purpose: it means one thing, and connection quality is not it.

### Live Custody Band

The client's panel, and only the client's panel, turns its header into a solid seal-red band the moment a session starts: a still 10px white square, the label "Session in progress" at micro size with 0.1em tracking at 85% opacity, the operator's name in weight 600 with an ellipsis clamp, and the running clock pushed right at lead size with tabular figures. It is the largest single application of seal red anywhere in the product, and it exists so the answer to "is someone in my machine right now" is legible from across a desk.

### Session Frame

A click-through window covering the whole display, above fullscreen apps: a 4px seal-red border with a 1px white-28% hairline inside it, and a centred tag at the very top edge — 5px/14px/6px padding, seal fill, white text — carrying the label, the operator's name, and the running clock, separated by 1px white-40% vertical rules 12px tall. It holds perfectly still. Because this window's content policy allows stylesheets but not inline styles, its rules live in their own file and its colours are literal rather than tokenised.

### Named Rules

**The One Button Family Rule.** Every surface draws from the same button component. Scale and variant may change; shape, stroke, motion and disabled treatment may not.

**The Sheet-Feed Rule.** Motion is 150ms linear and used only to show that something changed state — a fill, a border, a toolbar sliding away. The one animation in the system is three 22px marks advancing left to right at a constant rate in `steps(1, end)`, and it reports that a request is still open. Nothing eases, nothing bounces, nothing has a duration you would notice.

**The Still-Mark Rule.** Live indicators hold still. A pulsing border or a breathing dot is decoration pretending to be information; the state is carried by the band, the word, and the running clock.

## The mark

The application icon is the letter D with the operator's cursor crossing its
bowl — the two objects the product is about, in one shape.

Four rules hold it together:

- **Amber is the mark's colour and nothing else's.** It does not enter the
  console or the panel. Seal red keeps its single meaning there — control of
  this machine is currently released — and a second accent inside the
  document would blunt it.
- **The mark is stock-independent.** Graphite ground, amber letter, white
  cursor, on carbon and on paper alike. It is the one element that is not
  printed on either stock, because it appears where neither exists: a Dock,
  a browser tab, a system permissions list.
- **It is built to Apple's grid.** 824x824 body inside a 1024 canvas, corner
  radius 185.4, the surrounding 100 units transparent. macOS does not inset
  an icon for you, so a mark drawn to the edge of its canvas stands visibly
  taller than every system icon beside it in the Dock.
- **The horizontals are optically corrected, not geometrically equal.** The
  stem and the right of the bowl carry 84 units; the two arms carry 76, 9.5%
  less. Equal measured weight does not read as equal weight — a horizontal
  stroke always looks heavier than a vertical one of the same thickness, and
  type design has thinned them 8-12% for as long as there has been type. It
  is done by making the counter an ellipse while the outer bowl stays a true
  circle, so the correction lives in one number and the joins stay tangent-
  continuous.

The icon is generated from code — `scripts/make-icon.mjs`, run with
`npm run icon --workspace=@desky/host`. There is no binary source file to
keep in step, and the same paths are pasted into the two favicons in
`packages/server/public/`.

## Do's and Don'ts

### Do:

- **Do** derive a new surface's stock from where it will physically be read, then use the shared ink roles unchanged. Both stocks must render every component the system has.
- **Do** reserve seal red for "control of this machine is released to someone else" — the live band, the screen frame, the tag, and the control that ends the session.
- **Do** set every measured, ticking, or spoken value in PT Mono with `tabular-nums` and `'tnum' 1`, inside a fixed character cell (`min-width: 5.5ch` for toolbar readouts).
- **Do** build structure from a printed label, a 1px hairline, and the value in the field below it.
- **Do** print the measured value beside every state name, and change the marker's shape — 6px circle to 7px rotated square — when the state changes.
- **Do** keep motion at 150ms linear, and only where something has actually changed state.
- **Do** use the fixed type steps (0.6875 / 0.8125 / 0.9375 / 1.0625 / 1.375 / 2rem) and the seven-step spacing scale; reflow structure instead of scaling type.
- **Do** cap measures by role: 68ch for prose, 52ch for waiting copy, 46ch for panel body text, 40–42ch for notes.
- **Do** grey out disabled controls with `filter: grayscale(1)` and `opacity: 0.45` so unavailable never looks like loading.

### Don't:

- **Don't** use seal red for an error, a hover, a hyperlink, a chart, a badge, or a brand flourish. If it is not custody, it is not seal.
- **Don't** add a card, a shadow, a gradient, or a glow. There is not one `box-shadow` in this system and there should not be a first one.
- **Don't** invent a colour that exists on only one stock, and don't let a component supply its own background outside the three stock planes.
- **Don't** introduce a second accent hue, or tint a neutral toward one. Hierarchy is the four ink weights.
- **Don't** clamp or fluid-scale the shared type steps; `clamp()` belongs only to the two credential entry fields.
- **Don't** animate a live indicator. No pulse, no breathing border, no spinner — the waiting feed advances in discrete steps and that is the whole motion vocabulary.
- **Don't** let a ticking value reflow its neighbours, and don't drop the mono face on a number that is read aloud.
- **Don't** invent a new affordance. This is Operate mode: a menu opens under its control, a field is a field, a destructive control is a large labelled button with an icon.
- **Don't** ship a face without Cyrillic coverage or rely on a CDN for one; both faces are self-hosted with subset `unicode-range` declarations.
- **Don't** apply backdrop blur anywhere except over content the interface does not own.
