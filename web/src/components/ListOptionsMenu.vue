
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";

defineProps<{
  open: boolean;
  hideInstrumental: boolean;
}>();
const emit = defineEmits<{
  toggle: [];
  "update:hideInstrumental": [value: boolean];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="list-options-wrap" @click.stop>
    <button class="btn-secondary btn-sm list-options-btn" :title="t('library.listOptions')" @click="emit('toggle')">
      <Icon name="dot" /> {{ t("library.listOptions") }}
    </button>
    <div v-if="open" class="list-options-menu">
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
  </div>
</template>

<style scoped>
.list-options-wrap { position: relative; display: inline-flex; align-items: center; }
.list-options-menu {
  position: absolute;
  top: 100%; right: 0;
  z-index: 20;
  min-width: 240px;
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
