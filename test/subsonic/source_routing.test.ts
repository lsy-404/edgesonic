// SPDX-License-Identifier: AGPL-3.0-or-later

import { mapSongSources, selectSongSource } from "../../worker/src/endpoints/subsonic/sources";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const instances = [
  {
    id: "si-local", master_id: "sm-1", source_id: "r2-local", source_type: "original",
    source_dedup_key: null, parent_instance_id: null, storage_uri: "r2://music/song.flac",
    transcode_profile: null, suffix: "flac", content_type: "audio/flac", bit_rate: 1000,
    sample_rate: 44100, bit_depth: 16, channels: 2, duration: 180, size: 123456,
    missing: 0, expires_at: null, last_accessed_at: null, created_at: 0, updated_at: 0,
  },
  {
    id: "si-peer", master_id: "sm-1", source_id: "peer-a", source_type: "external",
    source_dedup_key: null, parent_instance_id: null, storage_uri: "subsonic://peer-a/rest/stream?id=remote-1",
    transcode_profile: null, suffix: "mp3", content_type: "audio/mpeg", bit_rate: 320,
    sample_rate: 44100, bit_depth: null, channels: 2, duration: 180, size: 654321,
    missing: 0, expires_at: null, last_accessed_at: null, created_at: 0, updated_at: 0,
  },
];

const local = selectSongSource(instances, "server-local", "server-local");
assert(local?.id === "si-local", "local server id selects a directly readable instance");
assert(selectSongSource(instances, "peer-a", "server-local")?.id === "si-peer", "source id selects its instance");
assert(selectSongSource(instances, "si-peer", "server-local")?.id === "si-peer", "instance id selects an exact source");
assert(selectSongSource([instances[1]], "server-local", "server-local") === null, "missing local copy is not replaced by a peer source");

const sources = mapSongSources(instances, "server-local");
assert(sources[0].id === "server-local" && sources[0].transcodable, "local source reports its server id and transcode eligibility");
assert(sources[1].id === "peer-a" && !sources[1].transcodable, "proxied source reports its source id and no local transcode eligibility");
assert(sources[0].size === 123456 && sources[0].suffix === "flac", "source metadata includes physical size and format");

if (failures) process.exitCode = 1;
