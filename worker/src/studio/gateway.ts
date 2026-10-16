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

// Workers RPC entrypoint for a trusted sibling Worker on the same account.
// Named entrypoints are reachable only through a service binding that names
// them (`entrypoint = "StudioGateway"`), never from the public internet.
// The logic lives in ./operations so tests can run it without the runtime.

import { WorkerEntrypoint } from "cloudflare:workers";
// index.ts re-exports this class; the default export is only read at call
// time, so the import cycle is harmless.
import edgesonic from "../index";
import { relayStudioRequest, studioPermissions, type StudioPermissions } from "./operations";

export class StudioGateway extends WorkerEntrypoint<Env> {
  permissions(subject: string): Promise<StudioPermissions | null> {
    return studioPermissions(this.env, subject);
  }

  relay(subject: string, request: Request): Promise<Response> {
    return relayStudioRequest(this.env, this.ctx, subject, request, edgesonic.fetch);
  }
}
