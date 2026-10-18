# UI Color Inventory

This inventory covers the complete color palette used by the web UI. Shared theme
values come from [`tokens.css`](../../../../src/web/styles/tokens.css). Use these
tokens directly; `--background` also provides borders and dividers in both
themes, and `--surface` provides cards, panels, search fields, and neutral
buttons. There is no separate line, navigation, or graph-background color
token. Search fields use `--surface` in both themes.

## Shared theme tokens

Each token appears once, with its value for each theme and the UI purpose it
serves. `--application-shell-border-width` controls border thickness and is not
a color.

| Token                      | Dark                              | Light                                | What it controls                                                                                                                                   |
|----------------------------|-----------------------------------|--------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| `--background`             | `#2e2e2e`                         | `#eef2f5`                            | App background, borders, dividers, light-theme icon backplates, and shimmer center                                                                 |
| `--surface`                | `#262626`                         | `#f7f9fb`                            | Catalog content and tables, Workspace and Pipeline Runs panels, search fields, neutral buttons, connection drawer, selection bar, and empty states |
| `--text-primary`                   | `#ffffff`                         | `#3c3a3e`                            | Primary text, controls, tags, and buttons; light-theme Spark wordmark                                                                              |
| `--text-secondary`              | `#9fb1ba`                         | `#9fb1ba`                            | Supporting text/icons, scrollbars, graph edges, outlines and minimap nodes, status strips, progress, sort indicators, canceled and unknown         |
| `--accent`                 | `#e25a1c`                         | `#e25a1c`                            | Actions, navigation, active favorite stars, waiting status, Spark wordmark and favicon                                                             |
| `--accent-hover`           | `#262626`                         | `#f5e1d6`                            | Shared application sidebar link hover background                                                                                                   |
| `--accent-soft`            | `#5b1e0b`                         | `#f5e1d6`                            | Dark orange selected surfaces and hover backgrounds for selected controls                                                                          |
| `--success`                | `#36c86a`                         | `#1f8f4d`                            | Running, completed, connected, deployed, succeeded, and success notice borders                                                                     |
| `--success-soft`           | `#12351f`                         | `#e8f7ee`                            | Soft success backgrounds                                                                                                                           |
| `--danger`                 | `#27171c`                         | `#fff7f6`                            | Main error-panel background                                                                                                                        |
| `--danger-soft`            | `#451f26`                         | `#fde8e6`                            | Show details button and soft error backgrounds                                                                                                     |
| `--danger-soft-hover`      | `#5a2b34`                         | `#fff1ef`                            | Light red hover for danger-filled buttons                                                                                                          |
| `--danger-surface`         | `#191114`                         | `#f7dfdc`                            | Expanded error details background                                                                                                                  |
| `--danger-border`          | `#8d424d`                         | `#c0352b`                            | Error borders and separators                                                                                                                       |
| `--danger-text`            | `#f2d8dc`                         | `#8f2924`                            | Error headings and primary error messages                                                                                                          |
| `--danger-soft-text`       | `#d7aeb4`                         | `#9a4a44`                            | Supporting text inside error panels                                                                                                                |
| `--shadow`                 | `0 12px 34px rgba(0, 0, 0, 0.28)` | `0 12px 34px rgba(31, 31, 31, 0.08)` | Overlay and floating-surface shadows                                                                                                               |
| `--status-succeeded-color` | `var(--success)`                  | `var(--success)`                     | Succeeded lifecycle state and minimap nodes                                                                                                        |
| `--status-running-color`   | `var(--success)`                  | `var(--success)`                     | Running lifecycle state and minimap nodes                                                                                                          |
| `--status-waiting-color`   | `var(--accent)`                   | `var(--accent)`                      | Waiting lifecycle state and minimap nodes                                                                                                          |
| `--status-failed-color`    | `#ef6470`                         | `#c0352b`                            | Failed lifecycle state and minimap nodes                                                                                                           |
| `--status-canceled-color`  | `var(--text-secondary)`                | `var(--text-secondary)`                   | Canceled lifecycle state and minimap nodes                                                                                                         |
| `--status-unknown-color`   | `var(--text-secondary)`                | `var(--text-secondary)`                   | Unknown lifecycle state and minimap nodes                                                                                                          |

## Additional literal colors and paint values

These are distinct paint values used outside the shared theme tokens. Each value
is listed once with its color name and what it colors.

| Color value                 | Color              | What it controls                               |
|-----------------------------|--------------------|------------------------------------------------|
| `currentColor`              | current text color | Favorite icon fill and status-check border     |
| `rgba(0, 0, 0, 0.22)`       | black              | Graph frame shadow                             |
| `rgba(0, 0, 0, 0.24)`       | black              | Graph node shadow                              |
| `rgba(0, 0, 0, 0.32)`       | black              | Graph action-menu shadow                       |
| `rgba(0, 0, 0, 0.35)`       | black              | Pipeline graph controls and minimap shadows    |
| `rgba(0, 0, 0, 0.42)`       | black              | Pipeline selection-bar shadow                  |
| `rgba(0, 0, 0, 0.45)`       | black              | Run picker and output-action menu shadows      |
| `rgba(11, 99, 206, 0.24)`   | blue               | Selected-node blue outline shadow              |
| `rgba(22, 35, 42, 0.72)`    | dark gray          | Catalog sample-table header background         |
| `rgba(255, 255, 255, 0.38)` | white              | Run-button menu separators                     |
| `rgba(255, 255, 255, 0.92)` | white              | Dark graph tools and asset-count surfaces      |
| `rgba(255, 255, 255, 0.94)` | white              | Light graph tools surface                      |
| `rgba(31, 31, 31, 0.12)`    | dark gray          | Graph tools and active-tab shadows             |
| `rgba(31, 31, 31, 0.14)`    | dark gray          | Hovered and selected graph-node shadows        |
| `rgba(31, 31, 31, 0.16)`    | dark gray          | Action-menu and graph-node-action shadows      |
| `rgba(31, 31, 31, 0.18)`    | dark gray          | Selected graph-node shadow                     |
| `rgba(45, 154, 225, 0.12)`  | blue               | Light-theme minimap viewport tint              |
| `rgba(45, 154, 225, 0.16)`  | blue               | Catalog search and filter focus ring           |
| `rgba(59, 140, 184, 0.16)`  | blue               | Active pipeline source-line background         |
| `rgba(91, 171, 219, 0.12)`  | light blue         | Dark-theme minimap viewport tint               |
| `transparent`               | transparent        | Clear backgrounds, borders, and graph surfaces |
