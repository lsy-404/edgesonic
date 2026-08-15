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

import { CfApiError } from "../relay";

// Cloudflare doesn't publish a stable "you are missing permission X" code for
// every 403 — most 403s just carry a generic auth-error message. The one code
// this project already relies on elsewhere is 10051 (R2 not subscribed on
// this account), documented in docs/DEPLOY_BY_AGENT.md from a live probe.
// Everything else falls back to pairing the raw Cloudflare message with the
// permission group the failing call actually needed, supplied by the caller
// as `context` — that's the only reliable way to say which permission is
// missing, since Cloudflare's own error body doesn't say it.
const R2_NOT_SUBSCRIBED_CODE = 10051;

export interface DescribedError {
  message: string;
  r2NotSubscribed: boolean;
}

export function describeCfError(error: unknown, context?: string): DescribedError {
  if (error instanceof CfApiError) {
    if (error.code === R2_NOT_SUBSCRIBED_CODE) {
      return { message: error.message, r2NotSubscribed: true };
    }
    if (error.status === 403) {
      const hint = context ? ` This call needs: ${context}.` : "";
      return { message: `Cloudflare rejected this as a permission error: ${error.message}.${hint}`, r2NotSubscribed: false };
    }
    return { message: error.message, r2NotSubscribed: false };
  }
  if (error instanceof Error) return { message: error.message, r2NotSubscribed: false };
  return { message: String(error), r2NotSubscribed: false };
}
