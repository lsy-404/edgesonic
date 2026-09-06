// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, ref } from "vue";
import { defineStore } from "pinia";

export type DetailKind = "none" | "now-playing" | "album" | "artist";

export const useDetailStore = defineStore("detail", () => {
  const kind = ref<DetailKind>("none");
  const target = ref<string | null>(null);
  const isOpen = computed(() => kind.value !== "none");

  function open(kindValue: Exclude<DetailKind, "none">, targetValue: string | null = null) {
    kind.value = kindValue;
    target.value = targetValue;
  }
  function openNowPlaying() { open("now-playing"); }
  function openAlbum(id: string) { if (id) open("album", id); }
  function openArtist(id: string) { if (id) open("artist", id); }
  function close() { kind.value = "none"; target.value = null; }
  function toggleNowPlaying() { isOpen.value && kind.value === "now-playing" ? close() : openNowPlaying(); }

  return { kind, target, isOpen, openNowPlaying, openAlbum, openArtist, close, toggleNowPlaying };
});
