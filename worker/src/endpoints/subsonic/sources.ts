// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseStorageUri } from "../../adapters";
import type { SongInstance } from "../../types/entities";

export interface SongSource {
  id: string;
  sourceId: string;
  instanceId: string;
  size?: number;
  suffix: string;
  contentType?: string;
  bitRate?: number;
  duration?: number;
  transcodable: boolean;
}

function isLocal(instance: SongInstance): boolean {
  return parseStorageUri(instance.storage_uri).scheme !== "subsonic";
}

export function selectSongSource(
  instances: SongInstance[],
  source: string | undefined,
  instanceId: string,
): SongInstance | null {
  if (!source) return instances[0] ?? null;
  if (source === instanceId) return instances.find(isLocal) ?? null;
  return instances.find((instance) => instance.id === source || instance.source_id === source) ?? null;
}

export function mapSongSources(instances: SongInstance[], instanceId: string): SongSource[] {
  return instances.map((instance) => {
    const scheme = parseStorageUri(instance.storage_uri).scheme;
    return {
      id: isLocal(instance) ? instanceId : instance.source_id,
      sourceId: instance.source_id,
      instanceId: instance.id,
      size: instance.size ?? undefined,
      suffix: instance.suffix,
      contentType: instance.content_type ?? undefined,
      bitRate: instance.bit_rate ?? undefined,
      duration: instance.duration ?? undefined,
      transcodable: scheme !== "subsonic",
    };
  });
}
