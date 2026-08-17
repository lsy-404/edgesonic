# Third-party notice

This directory vendors a subset of [WinUIonWeb](https://github.com/Furry-Xiyi/WinUIonWeb)
by Furry-Xiyi, a Vue implementation of Microsoft's WinUI/Fluent Design controls for the web.

- Upstream license: GNU General Public License v3.0 (see `LICENSE` in this directory).
- Files are vendored from `WinUIonWeb/src/{components,styles}`, unmodified except
  where noted below (GPL-3.0 §5 notice of changes).
- WinUIonWeb is an independent reimplementation; it does not use Microsoft's WinUI
  source and is not affiliated with or endorsed by Microsoft.

## Changes made to vendored files

- `components/WinCheckBox.vue`: the checked-state glyph was changed from the
  private-use-area codepoint `&#xE73E;` (a Segoe Fluent Icons checkmark, part of
  the intentionally-not-vendored icon font — see below) to the standard Unicode
  `&#x2713;` (CHECK MARK), so the checkbox renders a visible checkmark without
  that font installed.

Combining GPL-3.0 code into this AGPL-3.0-licensed project is permitted by the
Free Software Foundation's compatibility exception between GPLv3 and AGPLv3;
the combined work is distributed under AGPL-3.0, per the top-level `LICENSE`.

Vendored files:

- `components/WinButton.vue`
- `components/WinCheckBox.vue`
- `components/WinInfoBar.vue`
- `components/WinTextBlock.vue` (WinInfoBar dependency)
- `components/WinMenuFlyout.vue` (WinTextBlock dependency)
- `components/WinScrollViewer.vue` (WinMenuFlyout dependency)
- `components/i18n/index.ts`, `components/Strings/**` (built-in control a11y strings)
- `styles/theme.css` (Fluent Design token layer)

The proprietary Segoe icon font used by upstream's `WinUIOnWebIcons` font-family is
intentionally not vendored (Microsoft font, not freely redistributable); components
here are used with `IsIconVisible="false"` / `IsClosable="false"` to avoid depending
on it.
