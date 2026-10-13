<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { FluentSwitch } from "@platform-kit/fluent/vue";
import Icon from "./Icon.vue";
import { RouterLink } from "vue-router";
import { useKtvSettingsStore } from "../stores/ktvSettings";

const { t } = useI18n();
const settings = useKtvSettingsStore();
onMounted(() => { if (!settings.loaded) void settings.load(); });

async function setEnabled(enabled: boolean) { await settings.save({ enabled }); }
async function setMode(mode: "fair" | "fifo") { await settings.save({ mode }); }
async function setEmbeddedVideo(allowEmbeddedVideo: boolean) { await settings.save({ allowEmbeddedVideo }); }
</script>

<template>
  <section class="settings-section card" :class="{ open: settings.enabled }">
    <div class="section-body ktv-settings-body">
      <div class="ktv-settings-heading">
        <span class="section-icon"><Icon name="music" size="18" /></span>
        <div>
          <h2 class="section-title">{{ t("settings.ktv.title") }}</h2>
          <p class="feature-desc">{{ t("settings.ktv.description") }}</p>
        </div>
      </div>
      <label class="ktv-enable-row">
        <span class="tc-key">{{ t("settings.ktv.enable") }}</span>
        <FluentSwitch :model-value="settings.enabled" :disabled="settings.busy" :aria-label="t('settings.ktv.enable')" @update:model-value="setEnabled" />
      </label>
      <div class="ktv-mode-row">
        <span class="tc-key">{{ t("settings.ktv.mode") }}</span>
        <div class="ktv-mode-options" role="group" :aria-label="t('settings.ktv.mode')">
          <button type="button" class="btn-secondary btn-sm" :class="{ selected: settings.mode === 'fair' }" :disabled="settings.busy || !settings.enabled" @click="setMode('fair')">{{ t("settings.ktv.fair") }}</button>
          <button type="button" class="btn-secondary btn-sm" :class="{ selected: settings.mode === 'fifo' }" :disabled="settings.busy || !settings.enabled" @click="setMode('fifo')">{{ t("settings.ktv.fifo") }}</button>
        </div>
      </div>
      <label v-if="settings.mediaMode === 'compatible'" class="ktv-enable-row">
        <span class="tc-key">{{ t("settings.ktv.embeddedVideo") }}</span>
        <FluentSwitch :model-value="settings.allowEmbeddedVideo" :disabled="settings.busy" :aria-label="t('settings.ktv.embeddedVideo')" @update:model-value="setEmbeddedVideo" />
      </label>
      <p v-if="settings.mediaMode === 'compatible'" class="feature-desc">{{ settings.allowEmbeddedVideo ? t("settings.ktv.compatibilityHint") : t("settings.ktv.compatibilityDisabled") }}</p>
      <RouterLink v-if="settings.enabled" class="btn-primary ktv-entry" to="/ktv">{{ t("ktv.enterPrep") }}</RouterLink>
      <p v-if="settings.error" class="ktv-settings-error" role="alert">{{ settings.error }}</p>
    </div>
  </section>
</template>

<style scoped>
.ktv-settings-body { padding: 1rem 1.15rem; }
.ktv-settings-heading { display: flex; gap: .75rem; align-items: flex-start; margin-bottom: .9rem; }
.section-icon { color: var(--color-accent-primary); }
.section-title { margin: 0; font-size: 1rem; }
.feature-desc { margin: .25rem 0 0; }
.ktv-enable-row, .ktv-mode-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .75rem 0; border-top: 1px solid var(--color-border-subtle); }
.tc-key { color: var(--color-text-primary); }
.ktv-mode-options { display: flex; gap: .45rem; }
.ktv-entry { width: fit-content; margin-top: .85rem; text-decoration: none; }
.selected { border-color: var(--color-accent-primary); color: var(--color-accent-primary); }
.ktv-settings-error { color: var(--color-danger, #d13438); margin: .5rem 0 0; }
</style>
