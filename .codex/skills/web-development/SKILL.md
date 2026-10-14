---
name: web-development
description: UI implementation guidance for web design, accessibility, responsive behavior, shared components, and the Spark Control Plane design system.
---

# Web development

Use for frontend and visual changes. Read src/web/README.md and
src/web/AGENTS.md; for shared component work, also read
src/web/components/README.md and src/web/components/AGENTS.md. Keep page, route,
and component architecture in the local READMEs rather than here.

Use the design-system reference for typography, colors, spacing, breakpoints,
iconography, status presentation, and table behavior. Prefer shared components
and existing responsive patterns over page-local variants. Use AppIcon for
Lucide icons, StatusIcon for state icons, and preserve accessible labels and
keyboard behavior. Preserve loading, empty, and error states when changing a
page or reusable component, and check the affected interaction at the shared
responsive breakpoints.

For source-code ordering, comments, and documentation, use coding-style.
For tests and the mandatory post-change checklist, use testing and
development-workflow. This skill does not replace those checks.
