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

// Ark's click feedback — a white rhombus outline expanding from the pointer
// (see elements.css .ark-click-ping), replacing the crystal engine's default
// falling-piece drop for this theme only (wired via catalog.ts's
// `clickEffect`). mountCrystalBackground already skips registering any click
// handler under prefers-reduced-motion, so this never fires there.
export function arkClickPing(e: MouseEvent): void {
  const el = document.createElement("div");
  el.className = "ark-click-ping";
  el.style.left = `${e.clientX}px`;
  el.style.top = `${e.clientY}px`;
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  el.addEventListener("animationend", () => el.remove(), { once: true });
}
