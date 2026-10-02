# Findings

- Fluent release archive digest matches the supplied SHA256.
- Published package is `@platform-kit/fluent` version `0.2.5`; `/vue` and `/style.css` exports remain.
- The repository currently imports `@lsypkg/fluent` from several unowned areas. A package rename requires those imports to move in the same integration.
# Findings

- Fluent 0.2.5 exports `FluentButton` and `FluentScrollViewer`; the scroll viewer exposes `element()` and `scrollTo(options)` from its component ref.
- Renaming the web dependency makes old package imports in unowned sources fail typecheck. For isolated validation, those import specifiers were temporarily renamed in-place and restored immediately after the typecheck/build; tracked diffs confirm no unrelated source edits remain.
- Typecheck and production build pass with the coordinated imports. Build retains existing non-blocking browser `url` externalization and large-chunk notices.
