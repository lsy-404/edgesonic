// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { ref } from "vue";

export const SUPPORTED_THEME_MODES = ["light", "dark", "auto"] as const;
export type ThemeMode = (typeof SUPPORTED_THEME_MODES)[number];

const THEME_KEY = "edgesonic_installer_theme";

// vendor/winui's theme.css ships `html.theme-light` / `html.theme-dark`
// overrides (higher specificity than its `@media (prefers-color-scheme)`
// block) for exactly this — forcing a mode regardless of the OS setting.
// "auto" just means neither class is present, falling back to the media query.
function applyTheme(mode: ThemeMode) {
  document.documentElement.classList.remove("theme-light", "theme-dark");
  if (mode !== "auto") document.documentElement.classList.add(`theme-${mode}`);
}

function initialTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark" || saved === "auto") return saved;
  return "auto";
}

export const themeMode = ref<ThemeMode>(initialTheme());
applyTheme(themeMode.value);

export function setThemeMode(mode: ThemeMode) {
  themeMode.value = mode;
  localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
}
