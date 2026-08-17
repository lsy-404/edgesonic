<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { setLocale, type AppLocale } from "../i18n";
import { setThemeMode, themeMode, type ThemeMode } from "../theme";
import { useWizard } from "../stores/wizard";
import logo from "../assets/logo.svg";

const props = defineProps<{ step: number; total: number }>();

const { t, locale } = useI18n();
const wizard = useWizard();

// Step 7 (deploy) covers many real sub-steps; give its segment more of the
// bar's width and fill it in real time from wizard.stepStates instead of
// treating it like every other single-screen step.
const DEPLOY_STEP_NUMBER = 7;
const DEPLOY_SEGMENT_WEIGHT = 5;

const segments = computed(() =>
  Array.from({ length: props.total }, (_, i) => {
    const stepNum = i + 1;
    const weight = stepNum === DEPLOY_STEP_NUMBER ? DEPLOY_SEGMENT_WEIGHT : 1;
    let fill = 0;
    if (stepNum < props.step) {
      fill = 1;
    } else if (stepNum === props.step && stepNum === DEPLOY_STEP_NUMBER && wizard.stepStates.length > 0) {
      const total = wizard.stepStates.length;
      const done = wizard.stepStates.filter((s) => s.status === "success").length;
      const running = wizard.stepStates.filter((s) => s.status === "running").length;
      fill = (done + running * 0.5) / total;
    }
    return { stepNum, weight, fill };
  }),
);

const THEME_CYCLE: ThemeMode[] = ["light", "dark", "auto"];
function cycleTheme() {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode.value) + 1) % THEME_CYCLE.length];
  setThemeMode(next);
}

function cycleLocale() {
  const next: AppLocale = locale.value === "en" ? "zh-CN" : "en";
  setLocale(next);
}

const themeLabel = computed(() => t(`common.theme${themeMode.value.charAt(0).toUpperCase()}${themeMode.value.slice(1)}`));

</script>

<template>
  <div class="shell">
    <header class="shell-header">
      <div class="brand">
        <img :src="logo" alt="" width="32" height="32" />
        <span class="brand-name">{{ t("app.name") }}</span>
      </div>
      <div class="header-controls">
        <button type="button" class="icon-toggle" :title="themeLabel" :aria-label="themeLabel" @click="cycleTheme">
          <svg v-if="themeMode === 'light'" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <circle cx="10" cy="10" r="4" />
            <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4" />
          </svg>
          <svg v-else-if="themeMode === 'dark'" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16.5 12.5A7 7 0 1 1 7.5 3.5a5.5 5.5 0 0 0 9 9Z" />
          </svg>
          <svg v-else viewBox="0 0 20 20" width="18" height="18">
            <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M10 2.8a7.2 7.2 0 0 1 0 14.4Z" fill="currentColor" />
          </svg>
        </button>
        <button type="button" class="icon-toggle" :title="locale === 'en' ? 'English' : '中文'" :aria-label="locale === 'en' ? 'English' : '中文'" @click="cycleLocale">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <circle cx="10" cy="10" r="7.2" />
            <ellipse cx="10" cy="10" rx="3.2" ry="7.2" />
            <path d="M3 8h14M3 12h14" />
          </svg>
        </button>
      </div>
    </header>

    <div class="progress-track" aria-hidden="true">
      <div v-for="seg in segments" :key="seg.stepNum" class="progress-segment" :style="{ flexGrow: seg.weight }">
        <div class="progress-segment-fill" :style="{ width: seg.fill * 100 + '%' }" />
      </div>
    </div>
    <p class="step-caption">{{ t("common.stepOf", { current: step, total }) }}</p>

    <main class="shell-card">
      <!-- DOM order is actions-before-scroll so this target already exists
           when a step's Teleport tries to mount into it (Teleport requires
           its target to exist beforehand); flex `order` below puts it back
           after the scrolling content visually. Each step Teleports its own
           .step-actions here, so navigation stays pinned below the
           scrolling content instead of requiring a scroll to reach. -->
      <div class="shell-card-actions"></div>
      <div class="shell-card-scroll">
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px;
  box-sizing: border-box;
}

.shell-header {
  width: 100%;
  max-width: 1040px;
  flex: none;
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
  gap: 6px;
}

.icon-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--card-stroke);
  border-radius: 999px;
  background: var(--subtle-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--fast-duration, 0.167s) var(--fast-out-slow-in, ease), color var(--fast-duration, 0.167s);
}

.icon-toggle:hover {
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
}

.icon-toggle:active {
  background: var(--ctrl-fill-tertiary);
}

.progress-track {
  width: 100%;
  max-width: 1040px;
  flex: none;
  display: flex;
  gap: 4px;
  height: 3px;
}

.progress-segment {
  height: 100%;
  background: var(--subtle-secondary);
  border-radius: 999px;
  overflow: hidden;
}

.progress-segment-fill {
  height: 100%;
  background: var(--accent-base);
  transition: width 0.4s cubic-bezier(0.65, 0, 0.35, 1);
}

.step-caption {
  width: 100%;
  max-width: 1040px;
  flex: none;
  margin: 8px 0 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.shell-card {
  width: 100%;
  max-width: 1040px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--card-bg);
  backdrop-filter: blur(30px) saturate(160%);
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  margin-top: 16px;
  overflow: hidden;
}

.shell-card-scroll {
  order: 1;
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 32px;
}

.shell-card-actions {
  order: 2;
  flex: none;
  padding: 16px 32px;
  border-top: 1px solid var(--card-stroke);
}

@media (max-width: 560px) {
  .shell-card-scroll {
    padding: 20px;
  }

  .shell-card-actions {
    padding: 12px 20px;
  }
}
</style>
