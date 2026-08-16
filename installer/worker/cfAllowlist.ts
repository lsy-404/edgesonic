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

// The allowlist below must stay in sync with CONTRACT.md §1 — that file is
// the source of truth for *why* each entry exists.

// `null` marks an opaque path segment (accountId / scriptName / dbId / …):
// any non-empty value is accepted, format is not further validated.
type Segment = string | null;

interface Rule {
  method: string;
  segments: Segment[];
}

const ALLOWLIST: Rule[] = [
  { method: "GET", segments: ["accounts", null, "tokens", "verify"] },
  { method: "GET", segments: ["accounts", null, "tokens", null] },
  { method: "GET", segments: ["accounts", null] },
  { method: "GET", segments: ["accounts", null, "r2", "buckets"] },
  { method: "POST", segments: ["accounts", null, "r2", "buckets"] },
  { method: "GET", segments: ["accounts", null, "d1", "database"] },
  { method: "POST", segments: ["accounts", null, "d1", "database"] },
  { method: "POST", segments: ["accounts", null, "d1", "database", null, "query"] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts"] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts", null] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts", null, "deployments"] },
  { method: "POST", segments: ["accounts", null, "workers", "scripts", null, "versions"] },
  { method: "POST", segments: ["accounts", null, "workers", "scripts", null, "deployments"] },
  {
    method: "POST",
    segments: ["accounts", null, "workers", "scripts", null, "assets-upload-session"],
  },
  { method: "PUT", segments: ["accounts", null, "workers", "scripts", null, "secrets"] },
  { method: "GET", segments: ["accounts", null, "workers", "scripts", null, "schedules"] },
  { method: "PUT", segments: ["accounts", null, "workers", "scripts", null, "schedules"] },
  { method: "GET", segments: ["zones"] },
  { method: "GET", segments: ["zones", null, "settings", "image_resizing"] },
  { method: "POST", segments: ["accounts", null, "workers", "assets", "upload"] },
  { method: "GET", segments: ["accounts", null, "images", "v1", "stats"] },
  { method: "GET", segments: ["accounts", null, "workers", "domains"] },
  { method: "PUT", segments: ["accounts", null, "workers", "domains"] },
];

// Rejects empty segments (already implied by the caller's split/filter),
// "." / ".." traversal, and encoded slashes that could smuggle an extra
// path segment past the length check above.
function isValidOpaqueSegment(segment: string): boolean {
  if (!segment) return false;
  if (segment === "." || segment === "..") return false;
  if (/%2f/i.test(segment)) return false;
  return true;
}

export function isPathAllowed(method: string, segments: string[]): boolean {
  for (const rule of ALLOWLIST) {
    if (rule.method !== method) continue;
    if (rule.segments.length !== segments.length) continue;
    let matched = true;
    for (let i = 0; i < rule.segments.length; i++) {
      const expected = rule.segments[i];
      const actual = segments[i];
      if (expected === null) {
        if (!isValidOpaqueSegment(actual)) {
          matched = false;
          break;
        }
      } else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
