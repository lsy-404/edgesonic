
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import { placeFloatingMenu, type FloatingPlacement } from "../lib/floatingPlacement";
import Icon from "./Icon.vue";

const props = defineProps<{
  songId: string;
  title: string;
  starred: boolean;
  open: boolean;
  isAdmin: boolean;
}>();
const emit = defineEmits<{
  toggle: [];
  close: [];
  edit: [];
  share: [];
  addPlaylist: [];
  playNext: [];
  "update:starred": [value: boolean];
  error: [];
}>();

const { t } = useI18n();
const { authFetch, downloadUrl } = useAuth();
const starBusy = ref(false);
const buttonEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuPlaced = ref(false);
const menuPlacement = ref<FloatingPlacement>({ left: 0, top: 0, maxHeight: 0, placement: "bottom" });

const rowMenuStyle = computed<CSSProperties>(() => ({
  left: `${menuPlacement.value.left}px`,
  top: `${menuPlacement.value.top}px`,
  maxHeight: `${menuPlacement.value.maxHeight}px`,
  visibility: menuPlaced.value ? "visible" : "hidden",
}));

async function updateMenuPlacement() {
  if (!props.open) return;
  menuPlaced.value = false;
  await nextTick();
  const button = buttonEl.value;
  const menu = menuEl.value;
  if (!button || !menu || !props.open) return;
  menuPlacement.value = placeFloatingMenu(button.getBoundingClientRect(), menu.getBoundingClientRect(), {
    align: "right",
    gap: 4,
    margin: 8,
    minHeight: 120,
  });
  menuPlaced.value = true;
}

function closeForViewportChange() {
  emit("close");
}

function bindViewportListeners() {
  window.addEventListener("resize", closeForViewportChange);
  window.addEventListener("scroll", closeForViewportChange, true);
}

function unbindViewportListeners() {
  window.removeEventListener("resize", closeForViewportChange);
  window.removeEventListener("scroll", closeForViewportChange, true);
}

watch(() => props.open, (open) => {
  if (open) {
    bindViewportListeners();
    void updateMenuPlacement();
  } else {
    menuPlaced.value = false;
    unbindViewportListeners();
  }
});

onBeforeUnmount(unbindViewportListeners);

function pick(action: "edit" | "share" | "addPlaylist" | "playNext") {
  // emit()'s per-event overloads don't distribute over a union-typed
  // argument, so dispatch with a literal in each branch instead of
  // `emit(action)` directly.
  if (action === "edit") emit("edit");
  else if (action === "share") emit("share");
  else if (action === "playNext") emit("playNext");
  else emit("addPlaylist");
  emit("close");
}

async function toggleStar() {
  if (starBusy.value) return;
  const next = !props.starred;
  starBusy.value = true;
  try {
    const xml = await authFetch(next ? "star" : "unstar", { id: props.songId });
    if (/status="failed"/.test(xml)) throw new Error("star update failed");
    emit("update:starred", next);
    emit("close");
  } catch {
    emit("error");
  } finally {
    starBusy.value = false;
  }
}
</script>

<template>
  <div class="row-menu-wrap" @click.stop>
    <button ref="buttonEl" class="row-menu-btn" :class="{ active: open }" :title="t('library.moreActions')" @click="emit('toggle')"><Icon name="dots" /></button>
    <Teleport to="body">
      <div v-if="open" ref="menuEl" class="row-menu" :class="`open-${menuPlacement.placement}`" :style="rowMenuStyle" @click.stop>
        <button class="row-menu-item row-menu-like" :disabled="starBusy" @click="toggleStar"><Icon name="star" /> {{ props.starred ? t("library.unlike") : t("library.like") }}</button>
        <button class="row-menu-item" @click="pick('playNext')"><Icon name="queueNext" /> {{ t("library.playNext") }}</button>
        <button v-if="props.isAdmin" class="row-menu-item" @click="pick('edit')"><Icon name="edit" /> {{ t("library.editSong") }}</button>
        <button class="row-menu-item" @click="pick('share')"><Icon name="up" /> {{ t("library.share") }}</button>
        <button class="row-menu-item" @click="pick('addPlaylist')"><Icon name="check" /> {{ t("library.addToPlaylist") }}</button>
        <a class="row-menu-item" :href="downloadUrl(props.songId)" :download="props.title" @click="emit('close')"><Icon name="download" /> {{ t("library.download") }}</a>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.row-menu-wrap { position: relative; display: flex; align-items: center; justify-content: center; }
/* Matches the like button next to it: same box, border and hover treatment. */
.row-menu-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.row-menu-btn svg { width: 15px; height: 15px; }
.row-menu-btn:hover { color: var(--color-accent-primary); background: var(--color-bg-tertiary); }
.row-menu-btn.active { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.row-menu {
  position: fixed;
  z-index: 900;
  min-width: 160px;
  overflow-y: auto;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  padding: 0.25rem 0;
}
.row-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  padding: 0.4rem 0.75rem;
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: var(--fs-sm);
  font-family: inherit;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.row-menu-item:hover { background: var(--color-bg-tertiary); color: var(--color-accent-primary); }
.row-menu-like { display: none; }
@media (max-width: 768px) { .row-menu-like { display: block; } }
</style>
