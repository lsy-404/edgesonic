<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { callCfJson } from "../../lib/relay";
import { listBucketNames } from "../../lib/deploy/r2";
import { describeCfError } from "../../lib/cf/errors";

const { t } = useI18n();
const wizard = useWizard();

const verifying = ref(false);
const hasAttempted = ref(false);
const showToken = ref(false);
const showR2Secret = ref(false);

type CheckStatus = "pending" | "checking" | "ok" | "missing" | "error";
interface PermissionCheck {
  key: string;
  status: CheckStatus;
  detail: string;
}

// One row per thing the deploy actually needs — shown as a checklist rather
// than stopping at the first failure, so a half-configured token tells the
// user exactly which permission to go back and add instead of one opaque error.
const checks = reactive<PermissionCheck[]>([
  { key: "token", status: "pending", detail: "" },
  { key: "account", status: "pending", detail: "" },
  { key: "workersScripts", status: "pending", detail: "" },
  { key: "d1", status: "pending", detail: "" },
  { key: "r2", status: "pending", detail: "" },
]);

function setCheck(key: string, status: CheckStatus, detail = "") {
  const entry = checks.find((c) => c.key === key);
  if (entry) {
    entry.status = status;
    entry.detail = detail;
  }
}

const canVerify = computed(
  () =>
    wizard.credentials.accountId.trim().length > 0 &&
    wizard.credentials.apiToken.trim().length > 0 &&
    !verifying.value,
);

const allRequiredOk = computed(() => checks.filter((c) => c.key !== "r2").every((c) => c.status === "ok") && wizard.r2Enabled === true);

const canContinue = computed(
  () =>
    wizard.credentialsVerified &&
    allRequiredOk.value &&
    wizard.credentials.r2AccessKeyId.trim().length > 0 &&
    wizard.credentials.r2SecretAccessKey.trim().length > 0,
);

async function verify() {
  verifying.value = true;
  hasAttempted.value = true;
  wizard.credentialsVerified = false;
  wizard.r2Enabled = null;
  for (const c of checks) {
    c.status = "pending";
    c.detail = "";
  }
  const { accountId, apiToken } = wizard.credentials;

  setCheck("token", "checking");
  try {
    await callCfJson(apiToken, "/user/tokens/verify", undefined, "a valid token");
    setCheck("token", "ok");
  } catch (e) {
    setCheck("token", "error", describeCfError(e, "a valid token").message);
    verifying.value = false;
    return;
  }

  setCheck("account", "checking");
  try {
    const account = await callCfJson<{ id?: string; name?: string }>(apiToken, `/accounts/${accountId}`, undefined, "Account Settings Read");
    wizard.accountName = account.name || accountId;
    setCheck("account", "ok");
  } catch (e) {
    setCheck("account", "error", describeCfError(e, "Account Settings Read").message);
    verifying.value = false;
    return;
  }

  setCheck("workersScripts", "checking");
  try {
    await callCfJson(apiToken, `/accounts/${accountId}/workers/scripts`, undefined, "Workers Scripts Edit");
    setCheck("workersScripts", "ok");
  } catch (e) {
    setCheck("workersScripts", "missing", describeCfError(e, "Workers Scripts Edit").message);
  }

  setCheck("d1", "checking");
  try {
    await callCfJson(apiToken, `/accounts/${accountId}/d1/database`, undefined, "D1 Edit");
    setCheck("d1", "ok");
  } catch (e) {
    setCheck("d1", "missing", describeCfError(e, "D1 Edit").message);
  }

  setCheck("r2", "checking");
  try {
    await listBucketNames(apiToken, accountId);
    setCheck("r2", "ok");
    wizard.r2Enabled = true;
  } catch (e) {
    const described = describeCfError(e, "Workers R2 Storage Edit");
    if (described.r2NotSubscribed) {
      setCheck("r2", "missing", t("credentials.r2NotEnabled"));
      wizard.r2Enabled = false;
    } else {
      setCheck("r2", "error", described.message);
      wizard.r2Enabled = false;
    }
  }

  wizard.credentialsVerified = true;
  verifying.value = false;
}

function goNext() {
  wizard.step = 4;
}
function goBack() {
  wizard.step = 2;
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

    <ul v-if="hasAttempted" class="permission-checklist">
      <li v-for="c in checks" :key="c.key" :class="['permission-row', `permission-${c.status}`]">
        <span class="permission-dot" aria-hidden="true" />
        <div>
          <strong>{{ t(`credentials.checks.${c.key}`) }}</strong>
          <span class="permission-status">{{ t(`credentials.checkStatus.${c.status}`) }}</span>
          <p v-if="c.detail" class="field-help">{{ c.detail }}</p>
        </div>
      </li>
    </ul>

    <template v-if="wizard.credentialsVerified">
      <div v-if="wizard.accountName" class="alert alert-success" style="margin-top: 16px">
        {{ t("credentials.verified") }} — {{ t("credentials.accountNameLabel") }}: {{ wizard.accountName }}
      </div>

      <div v-if="wizard.r2Enabled === false" class="guide-card">
        <h3>{{ t("credentials.r2EnableLink") }}</h3>
        <ol>
          <li>{{ t("credentials.r2GuideStep1") }}</li>
          <li>{{ t("credentials.r2GuideStep2") }}</li>
        </ol>
        <a :href="`https://dash.cloudflare.com/${wizard.credentials.accountId}/r2/overview`" target="_blank" rel="noreferrer" class="btn btn-secondary">
          {{ t("credentials.r2EnableLink") }} ↗
        </a>
      </div>
      <p v-else-if="wizard.r2Enabled === true" class="field-help">{{ t("credentials.r2KeysUnverifiedNote") }}</p>
    </template>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!canContinue" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
