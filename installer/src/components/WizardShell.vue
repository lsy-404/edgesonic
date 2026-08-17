<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { setLocale, type AppLocale } from "../i18n";
import { setThemeMode, themeMode } from "../theme";
import logo from "../assets/logo.svg";

const props = defineProps<{ step: number; total: number }>();
void props;

const { t, locale } = useI18n();

function switchLocale(next: AppLocale) {
  setLocale(next);
}

const progressPct = computed(() => Math.min(100, Math.round(((props.step - 1) / (props.total - 1)) * 100)));
</script>

<template>
  <div class="shell">
    <header class="shell-header">
      <div class="brand">
        <img :src="logo" alt="" width="32" height="32" />
        <span class="brand-name">{{ t("app.name") }}</span>
      </div>
      <div class="header-controls">
        <div class="theme-switch" role="group" aria-label="Theme">
          <button type="button" :class="{ active: themeMode === 'light' }" @click="setThemeMode('light')">{{ t("common.themeLight") }}</button>
          <button type="button" :class="{ active: themeMode === 'dark' }" @click="setThemeMode('dark')">{{ t("common.themeDark") }}</button>
          <button type="button" :class="{ active: themeMode === 'auto' }" @click="setThemeMode('auto')">{{ t("common.themeAuto") }}</button>
        </div>
        <div class="lang-switch" role="group" aria-label="Language">
          <button type="button" :class="{ active: locale === 'en' }" @click="switchLocale('en')">EN</button>
          <button type="button" :class="{ active: locale === 'zh-CN' }" @click="switchLocale('zh-CN')">中文</button>
        </div>
      </div>
    </header>

    <div class="progress-track" aria-hidden="true">
      <div class="progress-fill" :style="{ width: progressPct + '%' }" />
    </div>
    <p class="step-caption">{{ t("common.stepOf", { current: step, total }) }}</p>

    <main class="shell-card">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px 48px;
}

.shell-header {
  width: 100%;
  max-width: 1040px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-name {
  font-weight: 600;
  font-size: 1.05rem;
  color: var(--text-primary);
}

.header-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.theme-switch,
.lang-switch {
  display: flex;
  gap: 2px;
  background: var(--subtle-secondary);
  border: 1px solid var(--card-stroke);
  border-radius: 999px;
  padding: 3px;
}

.theme-switch button,
.lang-switch button {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8rem;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: background var(--fast-duration, 0.167s) var(--fast-out-slow-in, ease), color var(--fast-duration, 0.167s);
}

.theme-switch button.active,
.lang-switch button.active {
  background: var(--accent-base);
  color: var(--accent-text);
  font-weight: 600;
}

.progress-track {
  width: 100%;
  max-width: 1040px;
  height: 3px;
  background: var(--subtle-secondary);
  border-radius: 999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-base);
  transition: width var(--normal-duration, 0.2s) var(--fast-out-slow-in, ease);
}

.step-caption {
  width: 100%;
  max-width: 1040px;
  margin: 8px 0 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.shell-card {
  width: 100%;
  max-width: 1040px;
  background: var(--card-bg);
  backdrop-filter: blur(30px) saturate(160%);
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 32px;
  margin-top: 16px;
}

@media (max-width: 560px) {
  .shell-card {
    padding: 20px;
  }
}
</style>
