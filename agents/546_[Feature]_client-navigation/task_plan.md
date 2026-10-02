# Client navigation and settings layout

## Scope
Extract Subsonic client credential management from Settings into its own route and improve Settings and Tools layout using the existing Fluent Vue components. Update navigation labels and the password-warning links.

## Steps
- [x] Inspect current settings credential code, shared nav/router, Fluent APIs, and existing locale keys.
- [x] Move credential state, API calls, watches, template, and styles into `SubsonicClients.vue`; preserve permission guard and safe one-time secret display.
- [x] Add independent route/navigation and point warning links to the route.
- [x] Improve Settings and Tools hierarchy and responsive card layout with existing components.
- [x] Add/update en and zh-CN copy for names and credential setup guidance.
- [x] Run project checks, review diff for secret/log and audit-marker issues, and commit this worktree.
