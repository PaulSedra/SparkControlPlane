# State semantics

- Succeeded/completed/connected: green.
- Waiting for resources on queued runs: orange; submitting and running: green.
- Failed/error/invalid: red.
- Unknown/draft/no data/canceled run: muted neutral.

The [color inventory](color-inventory.md) defines lifecycle colors.
`status.css` applies them to run labels and pipeline graph indicators;
`StatusIcon.css` applies them to lifecycle icons and owns their animation.
Status consumers provide the state and accessible label without setting the
icon foreground. Waiting uses an animated orange quarter-circle loader;
running uses a spinning green refresh icon.
