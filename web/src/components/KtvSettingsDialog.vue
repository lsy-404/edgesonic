<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useKtvSettingsStore } from "../stores/ktvSettings";
import Icon from "./Icon.vue";
import KtvSettingsCard from "./KtvSettingsCard.vue";
import MediaAccountsCard from "./MediaAccountsCard.vue";

const { t } = useI18n();
const settings = useKtvSettingsStore();
const dialog = ref<HTMLDialogElement | null>(null);
const opened = ref(false);

async function open() {
  opened.value = true;
  await nextTick();
  dialog.value?.showModal();
}

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="ktv-settings-dialog" :aria-label="t('ktv.openSettings')" @close="opened = false" @click.self="dialog?.close()">
    <template v-if="opened">
      <header class="settings-dialog-header">
        <h2>{{ t("ktv.openSettings") }}</h2>
        <button class="btn-secondary settings-dialog-close" type="button" :aria-label="t('common.close')" @click="dialog?.close()"><Icon name="cross" :size="18" /></button>
      </header>
      <div class="settings-dialog-body">
        <KtvSettingsCard />
        <MediaAccountsCard v-if="settings.canUseContainer && settings.mediaMode === 'full'" />
      </div>
    </template>
  </dialog>
</template>

<style scoped>
.ktv-settings-dialog { width: min(680px, calc(100vw - 2rem)); max-height: min(85dvh, 820px); margin: auto; padding: 0; color: var(--color-text-primary); background: var(--color-bg-secondary); border: 1px solid var(--card-stroke); border-radius: var(--ContentDialogCornerRadius); box-shadow: var(--ElevationControlFlyoutShadow); }
.ktv-settings-dialog::backdrop { background: #0008; }
.settings-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .8rem 1rem; border-bottom: 1px solid var(--card-stroke); }
.settings-dialog-header h2 { margin: 0; font-size: 1rem; }
.settings-dialog-close { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; }
.settings-dialog-body { display: grid; gap: 1rem; padding: 1rem; overflow-y: auto; max-height: calc(85dvh - 64px); }
</style>
