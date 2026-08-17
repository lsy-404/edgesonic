<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { WinButton, WinCheckBox } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();
const accepted = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const tosRead = ref(false);
let scrollContainer: HTMLElement | null = null;

// The ToS text itself no longer scrolls independently (that was a confusing
// nested-scroll-region), so "read to the end" is tracked against the shared
// .shell-card-scroll container it lives inside.
function checkTosRead() {
  const el = scrollContainer;
  if (!el) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) tosRead.value = true;
}

onMounted(() => {
  scrollContainer = rootRef.value?.closest(".shell-card-scroll") ?? null;
  scrollContainer?.addEventListener("scroll", checkTosRead);
  // Short terms that already fit without scrolling shouldn't permanently block the checkbox.
  nextTick(checkTosRead);
});

onUnmounted(() => {
  scrollContainer?.removeEventListener("scroll", checkTosRead);
});

function start() {
  wizard.step = 2;
}
</script>

<template>
  <div ref="rootRef">
    <h1 class="step-title">{{ t("welcome.title") }}</h1>
    <p class="step-subtitle">{{ t("welcome.subtitle") }}</p>

    <div class="guide-card">
      <h3>{{ t("welcome.termsTitle") }}</h3>
      <div class="tos-scroll">
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
      <p class="field-help"><a href="https://github.com/wuyilingwei/edgesonic/blob/main/docs/DEPLOY_BY_AGENT.md" target="_blank" rel="noreferrer">{{ t("welcome.advancedDeploy") }} ↗</a></p>
    </div>

    <WinCheckBox v-model="accepted" :IsEnabled="tosRead" style="margin-top: 20px">
      <span><span class="required-star" aria-hidden="true">*</span>{{ t("welcome.acceptTerms") }}</span>
    </WinCheckBox>
    <p v-if="!tosRead" class="field-help">{{ t("welcome.scrollToEnableTerms") }}</p>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="accepted" @Click="start">{{ t("welcome.start") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>
