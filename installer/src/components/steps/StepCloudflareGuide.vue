<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import ConsoleClickGuide from "../ConsoleClickGuide.vue";

const { t } = useI18n();
const wizard = useWizard();

function goNext() {
  wizard.step = 3;
}
function goBack() {
  wizard.step = 1;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("guide.title") }}</h1>
    <p class="step-subtitle">{{ t("guide.subtitle") }}</p>

    <dl class="kv-list">
      <div class="kv-row">
        <dt>{{ t("credentials.accountId") }}</dt>
        <dd>{{ t("guide.whatAccountId") }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("credentials.apiToken") }}</dt>
        <dd>{{ t("guide.whatApiToken") }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("guide.whatR2KeysLabel") }}</dt>
        <dd>{{ t("guide.whatR2Keys") }}</dd>
      </div>
    </dl>

    <div class="guide-card">
      <h3>{{ t("guide.step0Title") }}</h3>
      <p class="field-help">{{ t("guide.step0Desc") }}</p>
      <ConsoleClickGuide :heading="t('guide.loginScreenshotTitle')" :action="t('guide.loginScreenshotAction')" :detail="t('guide.loginScreenshotDetail')" :masked="t('guide.maskedEmail')" />
      <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noreferrer" class="btn btn-secondary">
        {{ t("guide.signUpLink") }} ↗
      </a>
    </div>

    <div class="guide-card">
      <h3>{{ t("guide.step1Title") }}</h3>
      <p class="field-help">{{ t("guide.step1Desc") }}</p>
      <ConsoleClickGuide :heading="t('guide.accountScreenshotTitle')" :action="t('guide.accountScreenshotAction')" :detail="t('guide.accountScreenshotDetail')" :masked="t('guide.maskedAccount')" />
    </div>

    <div class="guide-card">
      <h3>{{ t("guide.stepR2Title") }}</h3>
      <p class="field-help">{{ t("guide.stepR2Desc") }}</p>
      <ConsoleClickGuide :heading="t('guide.r2EnableScreenshotTitle')" :action="t('guide.r2EnableScreenshotAction')" :detail="t('guide.r2EnableScreenshotDetail')" />
      <a href="https://dash.cloudflare.com/?to=/:account/r2" target="_blank" rel="noreferrer" class="btn btn-secondary">
        {{ t("guide.r2EnableLink") }} ↗
      </a>
    </div>

    <div class="guide-card">
      <h3>{{ t("guide.step2Title") }}</h3>
      <ol>
        <li>{{ t("credentials.tokenGuideStep1") }}</li>
        <li>{{ t("credentials.tokenGuideStep2") }}</li>
        <li>{{ t("credentials.tokenGuideStep3") }}</li>
        <li>{{ t("credentials.tokenGuideStep4") }}</li>
      </ol>
      <ConsoleClickGuide :heading="t('guide.tokenScreenshotTitle')" :action="t('guide.tokenScreenshotAction')" :detail="t('guide.tokenScreenshotDetail')" />
      <ConsoleClickGuide :heading="t('guide.permissionScreenshotTitle')" :action="t('guide.permissionScreenshotAction')" :detail="t('guide.permissionScreenshotDetail')" />
      <ConsoleClickGuide :heading="t('guide.tokenResultScreenshotTitle')" :action="t('guide.tokenResultScreenshotAction')" :detail="t('guide.tokenResultScreenshotDetail')" :masked="t('guide.maskedToken')" />
      <a href="https://dash.cloudflare.com/?to=/:account/api-tokens" target="_blank" rel="noreferrer" class="btn btn-secondary">
        {{ t("credentials.apiTokenCreateLink") }} ↗
      </a>
    </div>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
