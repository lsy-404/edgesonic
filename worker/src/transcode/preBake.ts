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
// Triggers a pre-transcode for one profile against one song instance, right
// after upload. Unifies the two ways a profile ends up cached in
// song_instances(source_type='transcoded'):
//  - browser_pool: enqueue a work_queue row exactly like media.ts's on-demand
//    path does; the browser worker uploads the result to /work/upload, which
//    already does the R2 write + registerTranscodedInstance.
//  - sandbox/external: both transcode synchronously, so we do the R2 write +
//    registerTranscodedInstance ourselves here, mirroring work_upload.ts's
//    step 5-6 exactly (same R2 key convention, same registration call) so
//    the very next /rest/stream request for that profile hits the cache
//    regardless of which engine produced it.
// Always best-effort: callers run this under waitUntil and never surface a
// failure to the uploader — a failed pre-bake just means the first stream
// request at that quality transcodes on demand instead.

import { createQueries } from "../db/queries";
import { getProfile } from "./profiles";
import { buildTranscodeEngine } from "./factory";
import { BrowserPoolEngine } from "./browser_pool";
import { openSourceForTranscode } from "../endpoints/subsonic/media";
import { signUploadToken } from "../utils/workUploadToken";
import type { TranscodeInput } from "./engine";

export async function preBakeProfile(
  env: Env,
  origin: string,
  instanceId: string,
  profileId: string,
): Promise<void> {
  const profile = getProfile(profileId);
  if (!profile) return;

  const built = await buildTranscodeEngine(env);
  if (!built) return;
  const { engine, kind } = built;

  try {
    if (kind === "browser_pool" && engine instanceof BrowserPoolEngine) {
      const sourceUri = `${origin}/rest/stream?id=${encodeURIComponent(instanceId)}&format=raw`;
      await engine.enqueueTranscodeTask(sourceUri, instanceId, profile, async (queueId) => {
        const token = await signUploadToken(env, queueId);
        return `${origin}/edgesonic/work/upload?id=${encodeURIComponent(queueId)}&token=${encodeURIComponent(token)}`;
      });
      return;
    }

    const parent = await env.DB.prepare(
      "SELECT master_id, storage_uri FROM song_instances WHERE id = ?",
    ).bind(instanceId).first<{ master_id: string; storage_uri: string }>();
    if (!parent?.master_id) return;

    const source = await openSourceForTranscode(env, parent.storage_uri);
    if (!source) return;

    const input: TranscodeInput = { body: source.body, contentType: source.contentType };
    const out = await engine.transcode(input, profile);
    const bytes = new Uint8Array(await new Response(out.body).arrayBuffer());

    const r2Key = `cache/transcoded/${instanceId}_${profile.id}.${profile.container}`;
    await env.MUSIC_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: out.contentType } });

    const queries = createQueries(env.DB);

    await queries.registerTranscodedInstance({
      id: "si-pb-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16),
      masterId: parent.master_id,
      parentInstanceId: instanceId,
      storageUri: `r2://${r2Key}`,
      transcodeProfile: profile.id,
      suffix: profile.container,
      contentType: out.contentType,
      bitRate: profile.bitrate,
      size: bytes.byteLength,
    });
  } catch {
    // best-effort — see module comment
  }
}
