<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, nextTick, onBeforeUnmount, watch } from "vue";
import { useDetailStore } from "../stores/detail";
import NowPlaying from "../views/NowPlaying.vue";
import MediaDetail from "./MediaDetail.vue";

const detail = useDetailStore();
let previousFocus: HTMLElement | null = null;
const title = computed(() => detail.kind === "now-playing" ? "Now playing" : detail.kind === "album" ? "Album" : "Artist");
const mediaKind = computed<"album" | "artist">(() => detail.kind === "artist" ? "artist" : "album");

function close() { detail.close(); }
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && detail.isOpen) {
    event.preventDefault();
    close();
  }
}

watch(() => detail.isOpen, async (open) => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    document.querySelector<HTMLElement>(".detail-host__close")?.focus();
  } else {
    previousFocus?.focus();
    previousFocus = null;
  }
});
window.addEventListener("keydown", onKeydown);
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Transition name="detail-sheet">
    <section v-if="detail.isOpen" class="detail-host" role="dialog" aria-modal="true" :aria-label="title">
      <header class="detail-host__header">
        <span class="detail-host__eyebrow">{{ title }}</span>
        <button class="detail-host__close" type="button" aria-label="Close" @click="close">×</button>
      </header>
      <div class="detail-host__body">
        <NowPlaying v-if="detail.kind === 'now-playing'" embedded />
        <MediaDetail v-else-if="detail.target" :kind="mediaKind" :id="detail.target" @close="close" />
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.detail-host { position: fixed; z-index: 90; top: var(--nav-h); left: var(--sidebar-w); right: 0; bottom: calc(var(--player-h) + var(--bottom-nav-space, 0px)); display: flex; flex-direction: column; background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-bottom: 0; border-radius: 8px 8px 0 0; box-shadow: 0 -12px 40px rgb(0 0 0 / .3); overflow: hidden; }
.detail-host__header { height: 48px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-border-subtle); background: var(--color-bg-tertiary); }
.detail-host__eyebrow { font-size: var(--fs-sm); color: var(--color-text-secondary); font-weight: 600; }
.detail-host__close { width: 32px; height: 32px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-primary); font-size: 24px; line-height: 1; cursor: pointer; }
.detail-host__close:hover, .detail-host__close:focus-visible { background: var(--color-bg-elevated); outline: 2px solid var(--color-accent-primary); outline-offset: 1px; }
.detail-host__body { min-height: 0; flex: 1; overflow: auto; }
.detail-sheet-enter-active, .detail-sheet-leave-active { transition: transform .24s ease, opacity .18s ease; }
.detail-sheet-enter-from, .detail-sheet-leave-to { transform: translateY(100%); opacity: 0; }
@media (max-width: 960px) { .detail-host { top: var(--nav-h); left: 0; bottom: calc(var(--player-h) + var(--bottom-nav-space, 0px)); } }
@media (prefers-reduced-motion: reduce) { .detail-sheet-enter-active, .detail-sheet-leave-active { transition: none; } }
</style>
