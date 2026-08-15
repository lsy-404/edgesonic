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

// Ported near-verbatim from worker/src/utils/autoupdate.ts — crypto.subtle and
// manual base64 chunking are Web-standard APIs available in browsers too.

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Random superadmin password — matches docs/DEPLOY_BY_AGENT.md's 10-character convention. */
export function generatePassword(length = 10): string {
  const values = crypto.getRandomValues(new Uint32Array(length));
  let out = "";
  for (const value of values) out += PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length];
  return out;
}

/** WORK_UPLOAD_HMAC_KEY — the CLI runbook uses `openssl rand -base64 48`; this is its browser equivalent. */
export function generateHmacKeyBase64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return base64Bytes(bytes);
}
