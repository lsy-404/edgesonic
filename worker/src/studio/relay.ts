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

// Studio relay context shared by the gateway entrypoint and authMiddleware.
// The gateway dispatches into the app with a per-call env copy carrying the
// STUDIO_RELAY symbol; public traffic runs with the runtime's env and has no
// way to set a symbol key, so the relay identity can never come from a header,
// query parameter or env var.

import type { User } from "../types/entities";

export const STUDIO_RELAY = Symbol("edgesonic.studioRelay");

export interface StudioRelayContext {
  subject: string;
  user: User;
}

// Exact paths only; Subsonic routes also answer on their `.view` alias.
const RELAY_GET_OPERATIONS = [
  "ping", "search3", "getAlbumList2", "getAlbum", "getSong",
  "getCoverArt", "stream", "getLyricsBySongId",
];
const RELAY_ROUTES = new Set([
  ...RELAY_GET_OPERATIONS.flatMap((op) => [`GET /rest/${op}`, `GET /rest/${op}.view`]),
  "POST /storage/files/upload",
]);

export function isStudioRelayRoute(method: string, pathname: string): boolean {
  return RELAY_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

export function studioRelayContext(env: unknown): StudioRelayContext | null {
  if (!env || typeof env !== "object") return null;
  return (env as { [STUDIO_RELAY]?: StudioRelayContext })[STUDIO_RELAY] ?? null;
}

export function withStudioRelay<E extends object>(env: E, context: StudioRelayContext): E {
  return { ...env, [STUDIO_RELAY]: context };
}
