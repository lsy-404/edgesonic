<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { onBeforeUnmount, ref, watch } from "vue";
import { useAuth, formatDuration, parseXmlAttrs } from "../api";
import { usePlayerStore, type Track } from "../stores/player";
import { useDetailStore } from "../stores/detail";

const props = defineProps<{ kind: "album" | "artist"; id: string }>();
const emit = defineEmits<{ close: [] }>();
const { authFetch, coverArtUrl } = useAuth();
const player = usePlayerStore();
const detail = useDetailStore();
const name = ref("");
const subtitle = ref("");
const coverArt = ref("");
const tracks = ref<Track[]>([]);
const loading = ref(false);
let request = 0;

async function load() {
  const token = ++request;
  loading.value = true; tracks.value = [];
  try {
    if (props.kind === "album") {
      const xml = await authFetch("getAlbum", { id: props.id });
      if (token !== request) return;
      const album = parseXmlAttrs(xml, "album")[0] || {};
      name.value = album.name || "Album"; subtitle.value = album.artist || ""; coverArt.value = album.coverArt || "";
      tracks.value = parseXmlAttrs(xml, "song").map((s) => ({ id: s.id || "", title: s.title || "", artist: s.artist || album.artist || "", album: s.album || album.name || "", duration: Number(s.duration || 0), coverArt: s.coverArt || album.coverArt }));
    } else {
      const xml = await authFetch("getArtist", { id: props.id });
      if (token !== request) return;
      const artist = parseXmlAttrs(xml, "artist")[0] || {};
      name.value = artist.name || "Artist"; subtitle.value = artist.albumCount ? `${artist.albumCount} albums` : ""; coverArt.value = artist.coverArt || "";
      const albums = parseXmlAttrs(xml, "album");
      tracks.value = albums.map((album) => ({ id: album.id || "", title: album.name || "", artist: name.value, album: album.name || "", duration: Number(album.duration || 0), coverArt: album.coverArt }));
    }
  } finally { if (token === request) loading.value = false; }
}
watch(() => [props.kind, props.id], load, { immediate: true });
onBeforeUnmount(() => { request++; });
function play(index: number) {
  if (props.kind === "album") player.setQueue(tracks.value, index);
  else detail.openAlbum(tracks.value[index]?.id || "");
}
</script>

<template>
  <div class="media-detail">
    <div class="media-detail__hero">
      <img v-if="coverArt" :src="coverArtUrl(coverArt, 256)" alt="" />
      <div><p>{{ kind === 'album' ? 'Album' : 'Artist' }}</p><h1>{{ name }}</h1><span>{{ subtitle }}</span></div>
    </div>
    <p v-if="loading" class="media-detail__empty">Loading…</p>
    <div v-else-if="tracks.length" class="media-detail__list">
      <button v-for="(track, index) in tracks" :key="track.id" class="media-detail__track" type="button" @click="play(index)">
        <span>{{ index + 1 }}</span><span><b>{{ track.title }}</b><small>{{ track.artist }}</small></span><span>{{ formatDuration(track.duration) }}</span>
      </button>
    </div>
    <p v-else class="media-detail__empty">No music found.</p>
  </div>
</template>

<style scoped>
.media-detail { max-width: 960px; margin: 0 auto; padding: 32px; }
.media-detail__hero { min-height: 192px; display: flex; gap: 24px; align-items: end; padding-bottom: 24px; border-bottom: 1px solid var(--color-border-subtle); }
.media-detail__hero img { width: 176px; height: 176px; object-fit: cover; border-radius: 8px; background: var(--color-bg-tertiary); }
.media-detail__hero p, .media-detail__hero span, small { color: var(--color-text-secondary); }
.media-detail__hero h1 { margin: 6px 0; font-size: clamp(1.7rem, 4vw, 3rem); }
.media-detail__list { margin-top: 18px; }
.media-detail__track { width: 100%; display: grid; grid-template-columns: 36px 1fr auto; gap: 12px; padding: 10px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-primary); text-align: left; cursor: pointer; }
.media-detail__track:hover, .media-detail__track:focus-visible { background: var(--color-bg-tertiary); outline: 2px solid var(--color-accent-primary); }
.media-detail__track small { display: block; margin-top: 3px; }.media-detail__empty { padding: 32px 0; color: var(--color-text-secondary); }
@media (max-width: 600px) { .media-detail { padding: 20px 16px; }.media-detail__hero { align-items: center; }.media-detail__hero img { width: 104px; height: 104px; } }
</style>
