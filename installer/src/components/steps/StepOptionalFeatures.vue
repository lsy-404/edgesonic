<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import ConsoleClickGuide from "../ConsoleClickGuide.vue";

const { t } = useI18n();
const wizard = useWizard();

function goNext() {
  wizard.step = 5;
}
function goBack() {
  wizard.step = 3;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("optional.title") }}</h1>
    <p class="step-subtitle">{{ t("optional.subtitle") }}</p>

    <div class="card-option" style="cursor: default">
      <h3>
        {{ t("credentials.imagesCardTitle") }}
        <span class="field-tag recommended">{{ t("common.recommended") }}</span>
      </h3>
      <p>{{ t("credentials.imagesCardDesc") }}</p>
      <ConsoleClickGuide :heading="t('guide.imagesScreenshotTitle')" :action="t('guide.imagesScreenshotAction')" :detail="t('guide.imagesScreenshotDetail')" />
      <a :href="`https://dash.cloudflare.com/${wizard.credentials.accountId || ''}/images/transformations`" target="_blank" rel="noreferrer" class="btn btn-secondary">
        {{ t("credentials.imagesCardLink") }} ↗
      </a>
    </div>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" @click="goNext">{{ t("optional.skip") }}</button>
    </div>
  </div>
</template>
