
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { placeFloatingMenu, type FloatingPlacement } from "../lib/floatingPlacement";
import Icon from "./Icon.vue";

const props = defineProps<{
  open: boolean;
  hideInstrumental: boolean;
}>();
const emit = defineEmits<{
  toggle: [];
  close: [];
  "update:hideInstrumental": [value: boolean];
}>();

const { t } = useI18n();
const buttonEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuPlaced = ref(false);
const menuPlacement = ref<FloatingPlacement>({ left: 0, top: 0, maxHeight: 0, placement: "bottom" });

const menuStyle = computed<CSSProperties>(() => ({
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
</script>

<template>
  <div class="list-options-wrap" @click.stop>
    <button ref="buttonEl" class="btn-secondary btn-sm list-options-btn" :title="t('library.listOptions')" @click="emit('toggle')">
      <Icon name="dot" /> {{ t("library.listOptions") }}
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menuEl" class="list-options-menu" :class="`open-${menuPlacement.placement}`" :style="menuStyle" @click.stop>
        <label class="list-options-item">
          <span class="list-options-text">
            {{ t("library.hideInstrumental") }}
            <span class="list-options-hint">{{ t("library.hideInstrumentalHint") }}</span>
          </span>
          <span class="toggle">
            <input
              type="checkbox"
              :checked="hideInstrumental"
              @change="emit('update:hideInstrumental', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-slider"></span>
          </span>
        </label>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.list-options-wrap { position: relative; display: inline-flex; align-items: center; }
.list-options-menu {
  position: fixed;
  z-index: 900;
  min-width: 240px;
  overflow-y: auto;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  padding: 0.25rem 0;
}
.list-options-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: var(--fs-sm);
}
.list-options-item:hover { background: var(--color-bg-tertiary); }
.list-options-text { display: flex; flex-direction: column; gap: 0.15rem; }
.list-options-hint { color: var(--color-text-muted); font-size: var(--fs-xs); }
</style>
