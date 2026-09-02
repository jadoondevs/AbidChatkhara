# 023 — The look lives in tokens, not components

## Context

The POS was built with a dark slate palette, rounded corners and system
type. A design system arrived as the visual reference: Modernist — flat
and architectural, set in Archivo, a near-mono red on a light ground,
zero corner radius, strong 2px rules, labels flush left, the accent
spent sparingly.

That is close to an inversion of what was on screen. The question was
how to apply it without putting any working behaviour at risk: this
codebase's whole point is that a bill cannot silently change, and a
redesign that touched payment or printing logic to move a colour would
be the wrong trade at any fidelity.

## Decision

Every colour, size, rule and weight is a token in
`apps/frontend/src/index.css`, and every screen refers to the same
semantic class names it always did. The redesign is a rewrite of that
one file plus additive markup — a header block, a poster half on sign
in, a kicker above each page title — and nothing else.

Concretely:

- No component owns a hex, a font or a radius. `.item-tile` says what a
  tile is; the stylesheet says what it looks like.
- Class names and element ids are load-bearing and were preserved
  wholesale. They are what the screens, and the browser regression
  suites, address.
- Archivo is vendored via `@fontsource-variable/archivo` and precached
  with the app shell. The design system's stylesheet fetches it from
  Google Fonts; a local-first till cannot.
- `text-transform: uppercase` is applied to labels and status pills, and
  never to a rendered amount.

## Consequences

The visual change is total and the behavioural change is nil. All 659
unit tests, the typecheck, the lint and the production build passed
unchanged, and all seven browser regression suites — including the
thermal-print byte assertions and the legacy-database upgrade — pass
against the redesigned app.

Two real bugs surfaced while doing it, and both were fixed rather than
styled around:

- The dialog header gave its title `flex: 1` and then added a second
  flexible spacer, so every dialog heading was allotted half the width
  it had. It only became visible once headings were set in a display
  weight.
- The nav, now uppercase, is wider than the sentence case it replaced,
  and at 1500px it slid underneath the buttons to its right — a
  destination a manager could see but not click. The breakpoint at which
  the nav takes its own row moved from 1400px to 1700px.

The cost is that the stylesheet is long and must stay the single source
of the look. A component that reaches for its own colour breaks the
property this decision exists to buy.
