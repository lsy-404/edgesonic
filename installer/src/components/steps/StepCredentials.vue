<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { callCfJson } from "../../lib/relay";
import { listBucketNames } from "../../lib/deploy/r2";
import { describeCfError } from "../../lib/cf/errors";
import ScreenshotPlaceholder from "../ScreenshotPlaceholder.vue";

const { t } = useI18n();
const wizard = useWizard();

const verifying = ref(false);
const errorMessage = ref("");
const showToken = ref(false);
const showR2Secret = ref(false);

const canVerify = computed(
  () =>
    wizard.credentials.accountId.trim().length > 0 &&
    wizard.credentials.apiToken.trim().length > 0 &&
    !verifying.value,
);

const canContinue = computed(
  () =>
    wizard.credentialsVerified &&
    wizard.r2Enabled === true &&
    wizard.credentials.r2AccessKeyId.trim().length > 0 &&
    wizard.credentials.r2SecretAccessKey.trim().length > 0,
);

async function verify() {
  verifying.value = true;
  errorMessage.value = "";
  wizard.credentialsVerified = false;
  wizard.r2Enabled = null;
  const { accountId, apiToken } = wizard.credentials;
  try {
    await callCfJson(apiToken, "/user/tokens/verify", undefined, "a valid token");
    const account = await callCfJson<{ id?: string; name?: string }>(apiToken, `/accounts/${accountId}`, undefined, "Account Settings Read");
    wizard.accountName = account.name || accountId;

    try {
      await listBucketNames(apiToken, accountId);
      wizard.r2Enabled = true;
    } catch (e) {
      const described = describeCfError(e, "R2 Storage Bucket Edit");
      if (described.r2NotSubscribed) {
        wizard.r2Enabled = false;
      } else {
        throw e;
      }
    }
    wizard.credentialsVerified = true;
  } catch (e) {
    errorMessage.value = describeCfError(e, "Account Settings Read").message;
  } finally {
    verifying.value = false;
  }
}

function goNext() {
  wizard.step = 3;
}
function goBack() {
  wizard.step = 1;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("credentials.title") }}</h1>
    <p class="step-subtitle">{{ t("credentials.subtitle") }}</p>
    <div class="alert alert-warning">{{ t("credentials.sensitiveWarning") }}</div>

    <div class="field">
      <label for="accountId">{{ t("credentials.accountId") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="accountId" v-model.trim="wizard.credentials.accountId" type="text" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.accountIdHelp") }}</p>
    </div>

    <div class="field">
      <label for="apiToken">{{ t("credentials.apiToken") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="apiToken" v-model.trim="wizard.credentials.apiToken" :type="showToken ? 'text' : 'password'" autocomplete="off" spellcheck="false" />
      <p class="field-help">
        {{ t("credentials.apiTokenHelp") }}
        · <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem" @click="showToken = !showToken">{{ showToken ? t("common.hide") : t("common.show") }}</button>
      </p>
      <div class="guide-card">
        <h3>{{ t("credentials.tokenGuideTitle") }}</h3>
        <ol>
          <li>{{ t("credentials.tokenGuideStep1") }}</li>
          <li>{{ t("credentials.tokenGuideStep2") }}</li>
          <li>{{ t("credentials.tokenGuideStep3") }}</li>
        </ol>
        <ScreenshotPlaceholder :label="t('credentials.tokenGuideScreenshot')" />
        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" class="btn btn-secondary">
          {{ t("credentials.apiTokenCreateLink") }} ↗
        </a>
      </div>
    </div>

    <div class="field">
      <label for="r2Key">{{ t("credentials.r2AccessKeyId") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="r2Key" v-model.trim="wizard.credentials.r2AccessKeyId" type="text" autocomplete="off" spellcheck="false" />
    </div>
    <div class="field">
      <label for="r2Secret">{{ t("credentials.r2SecretAccessKey") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="r2Secret" v-model.trim="wizard.credentials.r2SecretAccessKey" :type="showR2Secret ? 'text' : 'password'" autocomplete="off" spellcheck="false" />
      <p class="field-help">
        {{ t("credentials.r2KeyHelp") }}
        · <button type="button" class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem" @click="showR2Secret = !showR2Secret">{{ showR2Secret ? t("common.hide") : t("common.show") }}</button>
      </p>
    </div>

    <button type="button" class="btn btn-secondary" :disabled="!canVerify" @click="verify">
      {{ verifying ? t("credentials.verifying") : t("credentials.verify") }}
    </button>

    <div v-if="errorMessage" class="alert alert-danger" style="margin-top: 16px">{{ errorMessage }}</div>

    <template v-if="wizard.credentialsVerified">
      <div class="alert alert-success" style="margin-top: 16px">
        {{ t("credentials.verified") }} — {{ t("credentials.accountNameLabel") }}: {{ wizard.accountName }}
      </div>

      <div class="kv-list" style="margin-top: 12px">
        <div class="kv-row">
          <dt>{{ t("credentials.r2CheckTitle") }}</dt>
          <dd>{{ wizard.r2Enabled ? t("credentials.r2Enabled") : t("credentials.r2NotEnabled") }}</dd>
        </div>
      </div>
      <div v-if="!wizard.r2Enabled" class="guide-card">
        <h3>{{ t("credentials.r2EnableLink") }}</h3>
        <ol>
          <li>{{ t("credentials.r2GuideStep1") }}</li>
          <li>{{ t("credentials.r2GuideStep2") }}</li>
        </ol>
        <ScreenshotPlaceholder :label="t('credentials.r2GuideScreenshot')" />
        <a :href="`https://dash.cloudflare.com/${wizard.credentials.accountId}/r2/overview`" target="_blank" rel="noreferrer" class="btn btn-secondary">
          {{ t("credentials.r2EnableLink") }} ↗
        </a>
      </div>
      <p v-else class="field-help">{{ t("credentials.r2KeysUnverifiedNote") }}</p>
    </template>

    <div class="card-option" style="cursor: default; margin-top: 20px">
      <h3>
        {{ t("credentials.imagesCardTitle") }}
        <span class="field-tag recommended">{{ t("common.recommended") }}</span>
      </h3>
      <p>{{ t("credentials.imagesCardDesc") }}</p>
      <ScreenshotPlaceholder :label="t('credentials.imagesGuideScreenshot')" />
      <a :href="`https://dash.cloudflare.com/${wizard.credentials.accountId || ''}/images/transformations`" target="_blank" rel="noreferrer" class="btn btn-secondary">
        {{ t("credentials.imagesCardLink") }} ↗
      </a>
    </div>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!canContinue" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
