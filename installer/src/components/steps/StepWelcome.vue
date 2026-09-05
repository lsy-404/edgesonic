<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { WinButton, WinCheckBox } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();
const accepted = ref(false);
const tosRef = ref<HTMLElement | null>(null);
const tosRead = ref(false);

function checkTosRead() {
  const el = tosRef.value;
  if (!el) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) tosRead.value = true;
}

// Forced pause independent of the scroll gate below — mirrors the review
// step's confirm delay, so accepting terms always takes a moment even if
// the text was already short enough not to need scrolling.
const CONFIRM_LOCK_SECONDS = 3;
const lockSecondsLeft = ref(CONFIRM_LOCK_SECONDS);
let lockTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  // Short terms that already fit without scrolling shouldn't permanently block the checkbox.
  nextTick(checkTosRead);
  lockTimer = setInterval(() => {
    lockSecondsLeft.value -= 1;
    if (lockSecondsLeft.value <= 0) clearInterval(lockTimer);
  }, 1000);
});

onUnmounted(() => clearInterval(lockTimer));

function start() {
  wizard.step = 2;
}
</script>

<template>
  <div class="step-welcome-fill">
    <h1 class="step-title">{{ t("welcome.title") }}</h1>
    <p class="step-subtitle">{{ t("welcome.subtitle") }}</p>

    <div class="guide-card tos-guide-card">
      <h3>{{ t("welcome.termsTitle") }}</h3>
      <div ref="tosRef" class="tos-scroll" @scroll="checkTosRead">
        <section class="tos-section">
          <h4>{{ t("welcome.section1Title") }}</h4>
          <p>{{ t("welcome.section1Body") }}</p>
        </section>
        <section class="tos-section">
          <h4>{{ t("welcome.section2Title") }}</h4>
          <ul>
            <li>{{ t("welcome.section2Item1") }}</li>
            <li>{{ t("welcome.section2Item2") }}</li>
            <li>{{ t("welcome.section2Item3") }}</li>
          </ul>
        </section>
        <section class="tos-section">
          <h4>{{ t("welcome.section3Title") }}</h4>
          <ul>
            <li>{{ t("welcome.section3Item1") }}</li>
            <li>{{ t("welcome.section3Item2") }}</li>
            <li>{{ t("welcome.section3Item3") }}</li>
          </ul>
        </section>
        <section class="tos-section">
          <h4>{{ t("welcome.section4Title") }}</h4>
          <p>{{ t("welcome.section4Body") }}</p>
        </section>
        <section class="tos-section">
          <h4>{{ t("welcome.section5Title") }}</h4>
          <p>{{ t("welcome.section5Body") }}</p>
        </section>
      </div>
      <p class="field-help"><a href="https://github.com/lsy-404/edgesonic/blob/main/docs/DEPLOY_BY_AGENT.md" target="_blank" rel="noreferrer">{{ t("welcome.advancedDeploy") }} ↗</a></p>
    </div>

    <div class="tos-accept-row">
      <WinCheckBox v-model="accepted" :IsEnabled="tosRead" style="margin-top: 20px">
        <span><span class="required-star" aria-hidden="true">*</span>{{ t("welcome.acceptTerms") }}</span>
      </WinCheckBox>
      <span v-if="!tosRead" class="field-help tos-hint">{{ t("welcome.scrollToEnableTerms") }}</span>
    </div>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="accepted && lockSecondsLeft <= 0" @Click="start">
          {{ lockSecondsLeft > 0 ? t("welcome.startWait", { seconds: lockSecondsLeft }) : t("welcome.start") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* This step's content should fit the shell's fixed-height card without an
   outer scroll — only the terms text itself scrolls, in whatever space is
   left after the title/checkbox/button take their fixed share. */
.step-welcome-fill {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.tos-guide-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tos-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
}

.tos-accept-row {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.tos-hint {
  margin: 20px 0 0;
}
</style>
