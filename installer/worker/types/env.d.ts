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

interface Env {
  // Comma-separated, exact-match allowlist of cross-origin callers permitted
  // to read this Worker's /cf and /r2 responses (e.g. a separately-hosted
  // fork of the frontend). The wizard's own same-origin calls never need
  // this. No wildcards — see CONTRACT.md §3. Read at request time so it can
  // be updated (Worker var or secret) without touching source.
  ALLOWED_ORIGINS?: string;
  // Static build output (installer/dist), bound via [assets] in wrangler.toml.
  ASSETS: Fetcher;
}
