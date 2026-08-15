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

// The server-side auto-updater (worker/src/utils/autoupdate.ts) health-checks
// by parsing the JSON /edgesonic/version response and comparing the version
// string — it runs inside a Worker, so no CORS rules apply to that fetch.
// This installer runs in a browser calling a *different* origin (the Worker
// it just deployed), which sends no Access-Control-Allow-Origin on that
// route, and CONTRACT.md doesn't cover proxying arbitrary deployed-
// worker URLs either. A `mode: "cors"` fetch would reject with the same
// opaque error on success and failure alike, so it can't be used here.
// `no-cors` is the only mode that can tell "the origin answered" from "the
// request never reached anything" — it can't read status or body, so this is
// a reachability probe, not a real version-match health check. Deployment
// success is really established by the earlier deployments-switch-traffic
// call (via the relay, so it can read the actual response) succeeding —
// this probe is an additional, best-effort, non-blocking signal on top.
export async function probeReachable(url: string, attempts = 3, delayMs = 1500): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fetch(url, { mode: "no-cors", cache: "no-store" });
      return true;
    } catch {
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
