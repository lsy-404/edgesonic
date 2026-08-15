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

// Worker script-version multipart uploads and asset chunks (CONTRACT.md §4)
// run a few MB each — this ceiling stays comfortably above real payloads
// while remaining well under the Workers platform's own request body cap.
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export class BodyTooLargeError extends Error {}

export async function readBodyWithLimit(req: Request, max: number): Promise<ArrayBuffer> {
  const declared = req.headers.get("Content-Length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > max) {
      throw new BodyTooLargeError();
    }
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) {
    throw new BodyTooLargeError();
  }
  return buf;
}
