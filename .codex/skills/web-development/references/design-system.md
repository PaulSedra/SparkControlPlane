# UI design system

## Typography

The base stack is Inter with system fallbacks. Root line height is `1.45`.

| Semantic use            | Current size                            |
|-------------------------|-----------------------------------------|
| Page title              | `1.25rem`                               |
| Brand                   | `1rem`                                  |
| Section/canvas title    | `0.98rem`                               |
| Body/default controls   | inherited, normally `1rem`              |
| Supporting text         | `0.84rem`–`0.9rem`                      |
| Tabs/breadcrumbs        | `0.8rem`                                |
| Table data/status       | `0.74rem`–`0.84rem`                     |
| Eyebrow/table headers   | `0.74rem`–`0.76rem`, uppercase, tracked |
| Compact type annotation | `0.62rem`                               |

Use `font-weight: 650` for actions, `750` for compact emphasis, and `800` for labels/headings. Do not introduce
arbitrary sizes when an existing semantic tier fits.

## Iconography

Use Lucide through `AppIcon`; use `StatusIcon` for status. Never draw an icon with CSS or substitute Unicode glyphs.

| AppIcon token | Pixels | Use                                                                                             |
|---------------|-------:|-------------------------------------------------------------------------------------------------|
| `status`      |     14 | Compact non-status action marks only; status state currently uses `StatusIcon` at control size. |
| `control`     |     16 | Buttons, inputs, toolbars, node types, and status circles.                                      |
| `brand`       |     20 | Product identity.                                                                               |
| `empty`       |     32 | Empty/loading placeholders.                                                                     |

Default stroke width is `2`. Decorative icons are hidden from assistive technology; meaningful icon-only controls
require a label.

## Colors

| Token                           | Value                            | Meaning                         |
|---------------------------------|----------------------------------|---------------------------------|
| `--bg`                          | `#f7f9fb`                        | Application background          |
| `--panel`                       | `#ffffff`                        | Primary surface                 |
| `--panel-soft`                  | `#f3f6fa`                        | Secondary surface/unknown state |
| `--text`                        | `#3c3a3e` (light), `#fff` (dark) | Primary text                    |
| `--muted`                       | `#607086`                        | Supporting text                 |
| `--line`                        | `#d8e0ea`                        | Borders/dividers                |
| `--accent`                      | `#e25a1c`                        | Primary action/navigation       |
| `--accent-soft`                 | `#e8f1ff`                        | Selected/hover accent           |
| `--success`                     | `#1f8f4d`                        | Completed/connected/deployed    |
| `--warning`                     | `#a96500`                        | Running/submitting              |
| `--danger`                      | `#c0352b`                        | Failed/error/invalid            |
| `--status-icon-succeeded-color` | `var(--success)`                 | Successful status icon          |
| `--status-icon-running-color`   | `var(--warning)`                 | Running status icon             |
| `--status-icon-failed-color`    | `var(--danger)`                  | Failed status icon              |
| `--status-icon-canceled-color`  | `var(--muted)`                   | Canceled status icon            |
| `--status-icon-unknown-color`   | `var(--muted)`                   | Unknown status icon             |

Each semantic state has a matching `-soft` background token. Prefer variables; consolidate repeated literal colors
before adding new ones.

## Geometry and layout

- Default border radius: `4px`; pill controls use `999px`; modal uses `12px`.
- Primary control height: 32–36px.
- Standard control gaps: 5–9px; page/section gaps: 12–20px.
- Main breakpoint: 1100px; compact breakpoint: 700px.
- Tables scroll horizontally rather than collapsing columns unpredictably.

## State semantics

- Succeeded/completed/connected: green.
- Running/submitting: amber.
- Failed/error/invalid: red.
- Unknown/draft/no data/canceled run: muted neutral.

StatusIcon owns status icon colors. Its shared stylesheet maps the namespaced
state classes (`status-icon--*`) to the corresponding `--status-icon-*-color`
tokens; status consumers provide the state and accessible label without setting
the icon foreground.
