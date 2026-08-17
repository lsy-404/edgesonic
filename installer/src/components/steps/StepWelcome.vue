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
      <ul style="margin: 8px 0 0; padding-left: 20px">
        <li>{{ t("welcome.termAccount") }}</li>
        <li>{{ t("welcome.termData") }}</li>
        <li>{{ t("welcome.termSupport") }}</li>
        <li>{{ t("welcome.termProxy") }}</li>
        <li>{{ t("welcome.termRecovery") }}</li>
        <li>{{ t("welcome.termNaming") }}</li>
      </ul>
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
