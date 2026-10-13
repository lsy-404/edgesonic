// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KtvMediaMode, KtvQueueMode } from "../../../shared/ktv";

export async function ktvSettings(env: Env, username: string): Promise<{ enabled: boolean; mode: KtvQueueMode; mediaMode: KtvMediaMode; allowEmbeddedVideo: boolean; canUseContainer: boolean }> {
  const rows = await env.DB.prepare("SELECT key, value FROM user_settings WHERE username = ? AND key IN ('ktv_enabled', 'ktv_queue_mode', 'ktv_media_mode', 'ktv_allow_embedded_video')")
    .bind(username).all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, row.value]));
  return { enabled: values.get("ktv_enabled") === "1", mode: values.get("ktv_queue_mode") === "fifo" ? "fifo" : "fair",
    mediaMode: env.MediaContainer && values.get("ktv_media_mode") !== "compatible" ? "full" : "compatible",
    allowEmbeddedVideo: values.get("ktv_allow_embedded_video") === "1", canUseContainer: !!env.MediaContainer };
}
