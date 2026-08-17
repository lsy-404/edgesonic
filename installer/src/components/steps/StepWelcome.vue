<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";

const { t } = useI18n();
const wizard = useWizard();
const accepted = ref(false);

function start() {
  wizard.step = 2;
}
</script>

<template>
  <div>
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
      </div>
      <p class="field-help"><a href="https://github.com/wuyilingwei/edgesonic/blob/main/docs/DEPLOY_BY_AGENT.md" target="_blank" rel="noreferrer">{{ t("welcome.advancedDeploy") }} ↗</a></p>
    </div>

    <label class="check-row" style="margin-top: 20px">
      <input v-model="accepted" type="checkbox" />
      <span>{{ t("welcome.acceptTerms") }}<span class="required-star" aria-hidden="true">*</span></span>
    </label>

    <div class="step-actions">
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!accepted" @click="start">{{ t("welcome.start") }}</button>
    </div>
  </div>
</template>
