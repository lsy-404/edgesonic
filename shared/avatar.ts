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

// Default avatar for accounts that never uploaded one. Shared so the web UI
// draws it locally (no request) while the server renders the identical image
// for clients that only know how to fetch getAvatar.

// Muted, evenly-spaced hues that stay legible against white glyphs in both
// the light and dark palettes.
const AVATAR_COLORS = [
  "#4f6d7a", "#7a5c61", "#5b6c5d", "#6b5b8a", "#8a6a4f",
  "#3f6a68", "#7a4f5c", "#556b8a", "#6a7a4f", "#7a6a8a",
];

/** Stable per-name index — same account always gets the same colour. */
function hashIndex(name: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h % buckets;
}

export function defaultAvatarColor(username: string): string {
  return AVATAR_COLORS[hashIndex(username || "?", AVATAR_COLORS.length)];
}

/**
 * Leading glyph shown on the avatar. Array.from keeps astral characters
 * (emoji, rare CJK) whole instead of splitting a surrogate pair.
 */
export function defaultAvatarInitial(username: string): string {
  const first = Array.from((username || "").trim())[0];
  return first ? first.toUpperCase() : "?";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Self-contained SVG so no font or asset has to travel with the response. */
export function defaultAvatarSvg(username: string, size = 200): string {
  const bg = defaultAvatarColor(username);
  const initial = escapeXml(defaultAvatarInitial(username));
  const half = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeXml(username)}">`
    + `<rect width="${size}" height="${size}" fill="${bg}"/>`
    + `<text x="${half}" y="${half}" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"`
    + ` font-size="${Math.round(size * 0.44)}" font-weight="600" text-anchor="middle" dominant-baseline="central">${initial}</text>`
    + `</svg>`;
}
