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

//
// Super-admin only. Reports whether R2 presigning is enabled, configured, and
// accepted by R2. Secret values are never returned.

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getFeatureString } from "../../utils/features";
import { checkR2Credentials } from "../../utils/r2presign";
import type { User } from "../../types/entities";

export const r2presignRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

r2presignRoutes.get("/r2presign/status", permissionMiddleware("manage_permissions"), async (c) => {
  const env = c.env as Env;
  const flag = await getFeatureString(env, "enable_r2_presign", "0");
  const secretsConfigured = Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CF_ACCOUNT_ID);
  // null means the check was not attempted because configuration is incomplete.
  let credentialValid: boolean | null = null;
  if (secretsConfigured) {
    try {
      const { ok } = await checkR2Credentials({
        bucket: env.R2_BUCKET_NAME || "edgesonic-music",
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
        accountId: env.CF_ACCOUNT_ID as string,
      });
      credentialValid = ok;
    } catch {
      credentialValid = false;
    }
  }
  return c.json({
    ok: true,
    enabled: flag === "1",
    secretsConfigured,
    credentialValid,
    active: flag === "1" && secretsConfigured && credentialValid !== false,
  });
});
