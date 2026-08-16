<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { callCfJson, verifyR2Keys } from "../../lib/relay";
import { listBucketNames } from "../../lib/deploy/r2";
import { describeCfError } from "../../lib/cf/errors";
import { hasTokenPermission, readTokenPermissionGroups, TOKEN_PERMISSION_GROUPS } from "../../lib/cf/tokenPolicies";

const { t } = useI18n();
const wizard = useWizard();
const permissionRows = [
  { key: "apiTokens", category: "account", required: true, scope: "account", level: "read" },
  { key: "scripts", category: "developer", required: true, scope: "account", level: "write" },
  { key: "d1", category: "developer", required: true, scope: "account", level: "write" },
  { key: "r2", category: "developer", required: true, scope: "account", level: "write" },
  { key: "r2Keys", category: "developer", required: false, scope: "allBuckets", level: "readWrite" },
  { key: "ci", category: "developer", required: false, scope: "account", level: "write" },
  { key: "containers", category: "developer", required: false, scope: "account", level: "write" },
  { key: "observability", category: "analytics", required: false, scope: "account", level: "write" },
  { key: "accountAnalytics", category: "analytics", required: false, scope: "account", level: "read" },
  { key: "accountSettings", category: "account", required: false, scope: "account", level: "read" },
  { key: "zoneRead", category: "zone", required: false, scope: "targetZone", level: "read" },
  { key: "zoneSettings", category: "zone", required: false, scope: "targetZone", level: "read" },
] as const;

const verifying = ref(false);
const hasAttempted = ref(false);

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
  { key: "apiTokens", status: "pending", detail: "" },
  ...Object.keys(TOKEN_PERMISSION_GROUPS).filter((key) => key !== "apiTokens").map((key) => ({ key, status: "pending" as CheckStatus, detail: "" })),
  { key: "r2Keys", status: "pending", detail: "" },
]);

function setCheck(key: string, status: CheckStatus, detail = "") {
  const entry = checks.find((c) => c.key === key);
  if (entry) {
    entry.status = status;
    entry.detail = detail;
  }
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const API_TOKEN_RE = /^cfat_[A-Za-z0-9_-]{20,}$/;

const canVerify = computed(
  () =>
    ACCOUNT_ID_RE.test(wizard.credentials.accountId.trim()) &&
    API_TOKEN_RE.test(wizard.credentials.apiToken.trim()),
);
const r2KeysComplete = computed(() => {
  const accessKey = wizard.credentials.r2AccessKeyId.trim();
  const secret = wizard.credentials.r2SecretAccessKey.trim();
  return (!accessKey && !secret) || (!!accessKey && !!secret);
});

const requiredCheckKeys = new Set(["token", "apiTokens", "scripts", "d1", "r2"]);
const allRequiredOk = computed(
  () => checks.filter((check) => requiredCheckKeys.has(check.key)).every((check) => check.status === "ok")
    && wizard.r2Enabled === true,
);

const canContinue = computed(
  () =>
    wizard.credentialsVerified &&
    allRequiredOk.value && r2KeysComplete.value,
);

let verifyTimer: ReturnType<typeof setTimeout> | undefined;
let verifyGeneration = 0;
watch(
  () => [wizard.credentials.accountId, wizard.credentials.apiToken].join("\0"),
  () => {
    verifyGeneration++;
    clearTimeout(verifyTimer);
    verifying.value = false;
    wizard.credentialsVerified = false;
    wizard.r2Enabled = null;
    for (const check of checks) {
      check.status = "pending";
      check.detail = "";
    }
    if (!canVerify.value) return;
    verifyTimer = setTimeout(() => {
      void verify();
    }, 400);
  },
  { immediate: true },
);

watch(
  () => [wizard.credentials.r2AccessKeyId, wizard.credentials.r2SecretAccessKey].join("\0"),
  () => {
    if (!wizard.credentialsVerified || wizard.r2Enabled !== true) return;
    const { accountId, r2AccessKeyId, r2SecretAccessKey } = wizard.credentials;
    if (!r2AccessKeyId || !r2SecretAccessKey) {
      setCheck("r2Keys", r2AccessKeyId || r2SecretAccessKey ? "missing" : "pending", r2AccessKeyId || r2SecretAccessKey ? t("credentials.r2KeysPairRequired") : t("credentials.r2KeysOptionalSkipped"));
      return;
    }
    setCheck("r2Keys", "checking");
    void verifyR2Keys({ accountId, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey })
      .then((result) => {
        if (wizard.credentials.r2AccessKeyId !== r2AccessKeyId || wizard.credentials.r2SecretAccessKey !== r2SecretAccessKey) return;
        setCheck("r2Keys", result.ok ? "ok" : "missing", result.ok ? "" : t("credentials.r2KeyInvalid"));
      })
      .catch(() => setCheck("r2Keys", "error", t("credentials.r2KeyInvalid")));
  },
);
onUnmounted(() => {
  verifyGeneration++;
  clearTimeout(verifyTimer);
});

async function verify() {
  const generation = ++verifyGeneration;
  verifying.value = true;
  hasAttempted.value = true;
  wizard.credentialsVerified = false;
  wizard.r2Enabled = null;
  for (const c of checks) {
    c.status = "pending";
    c.detail = "";
  }
  const { accountId, apiToken } = wizard.credentials;
  const isStale = () => generation !== verifyGeneration;

  setCheck("token", "checking");
  let tokenId: string | undefined;
  try {
    const token = await callCfJson<{ id?: string }>(apiToken, `/accounts/${accountId}/tokens/verify`, undefined, "an active Account API Token");
    if (isStale()) return;
    setCheck("token", "ok");
    if (!token.id) throw new Error("Cloudflare did not return the API Token identifier");
    tokenId = token.id;
  } catch (e) {
    if (isStale()) return;
    setCheck("token", "error", describeCfError(e, "an active Account API Token").message);
    verifying.value = false;
    return;
  }

  try {
    setCheck("apiTokens", "checking");
    const groups = await readTokenPermissionGroups(apiToken, accountId, tokenId);
    if (isStale()) return;
    for (const key of Object.keys(TOKEN_PERMISSION_GROUPS) as Array<keyof typeof TOKEN_PERMISSION_GROUPS>) {
      setCheck(key, hasTokenPermission(groups, key) ? "ok" : "missing");
    }
  } catch (e) {
    if (isStale()) return;
    const context = describeCfError(e, "Account API Tokens Read").message;
    setCheck("apiTokens", "missing", context);
  }

  wizard.accountName = accountId;

  setCheck("scripts", "checking");
  try {
    await callCfJson(apiToken, `/accounts/${accountId}/workers/scripts`, undefined, "Workers Scripts Write");
    if (isStale()) return;
    setCheck("scripts", "ok");
  } catch (e) {
    if (isStale()) return;
    setCheck("scripts", "missing", describeCfError(e, "Workers Scripts Write").message);
  }

  setCheck("d1", "checking");
  try {
    await callCfJson(apiToken, `/accounts/${accountId}/d1/database`, undefined, "D1 Write");
    if (isStale()) return;
    setCheck("d1", "ok");
  } catch (e) {
    if (isStale()) return;
    setCheck("d1", "missing", describeCfError(e, "D1 Write").message);
  }

  setCheck("r2", "checking");
  try {
    await listBucketNames(apiToken, accountId);
    if (isStale()) return;
    setCheck("r2", "ok");
    wizard.r2Enabled = true;
    const { r2AccessKeyId, r2SecretAccessKey } = wizard.credentials;
    if (r2AccessKeyId && r2SecretAccessKey) {
      setCheck("r2Keys", "checking");
      const r2Keys = await verifyR2Keys({ accountId, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey });
      if (isStale()) return;
      if (r2Keys.ok) setCheck("r2Keys", "ok");
      else setCheck("r2Keys", "missing", t("credentials.r2KeyInvalid"));
    } else {
      setCheck("r2Keys", "pending", t("credentials.r2KeysOptionalSkipped"));
    }
  } catch (e) {
    if (isStale()) return;
    const described = describeCfError(e, "Workers R2 Storage Edit");
    if (described.r2NotSubscribed) {
      setCheck("r2", "missing", t("credentials.r2NotEnabled"));
      wizard.r2Enabled = false;
      setCheck("r2Keys", "pending");
    } else {
      setCheck("r2", "error", described.message);
      wizard.r2Enabled = false;
      setCheck("r2Keys", "pending");
    }
  }

  if (!isStale()) {
    wizard.credentialsVerified = true;
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

    <div v-if="wizard.mode === 'overwrite'" class="alert alert-warning">
      <strong>{{ t("overwriteAdvice.title") }}</strong>
      <p>{{ t("overwriteAdvice.message") }}</p>
    </div>

    <div class="guide-card credential-setup">
      <h3>{{ t("credentials.setupTitle") }}</h3>
      <ol>
        <li><a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noreferrer">{{ t("credentials.createAccount") }} ↗</a></li>
        <li>{{ t("credentials.setupToken") }} <a href="https://dash.cloudflare.com/?to=/:account/api-tokens" target="_blank" rel="noreferrer">{{ t("credentials.apiTokenCreateLink") }} ↗</a></li>
        <li>
          {{ t("credentials.setupPermissions") }}
          <div class="permission-table-wrap">
            <table class="permission-table">
              <thead>
                <tr>
                  <th>{{ t("credentials.permissionResource") }}</th>
                  <th>{{ t("credentials.permissionCategory") }}</th>
                  <th>{{ t("credentials.permissionRequired") }}</th>
                  <th>{{ t("credentials.permissionScenario") }}</th>
                  <th>{{ t("credentials.permissionScope") }}</th>
                  <th>{{ t("credentials.permissionLevel") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="permission in permissionRows" :key="permission.key">
                  <td>{{ t(`credentials.permissions.${permission.key}.resource`) }}</td>
                  <td>{{ t(`credentials.permissionCategories.${permission.category}`) }}</td>
                  <td>
                    <span
                      :class="permission.required ? 'requirement-required' : 'requirement-optional'"
                      :title="permission.required ? t('credentials.required') : t('credentials.optional')"
                      :aria-label="permission.required ? t('credentials.required') : t('credentials.optional')"
                    >{{ permission.required ? '✓' : '×' }}</span>
                  </td>
                  <td>{{ t(`credentials.permissions.${permission.key}.scenario`) }}</td>
                  <td>{{ t(`credentials.permissionScopes.${permission.scope}`) }}</td>
                  <td>{{ t(`credentials.permissionLevels.${permission.level}`) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="field-help">{{ t("credentials.dnsNotNeeded") }}</p>
        </li>
      </ol>
    </div>

    <div class="field">
      <label for="accountId">{{ t("credentials.accountId") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="accountId" v-model.trim="wizard.credentials.accountId" type="text" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.accountIdHelp") }}</p>
    </div>

    <div class="field">
      <label for="apiToken">{{ t("credentials.apiToken") }}<span class="field-tag required">{{ t("common.required") }}</span></label>
      <input id="apiToken" v-model.trim="wizard.credentials.apiToken" type="password" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.apiTokenHelp") }}</p>
    </div>

    <div class="field">
      <label for="r2Key">{{ t("credentials.r2AccessKeyId") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
      <input id="r2Key" v-model.trim="wizard.credentials.r2AccessKeyId" type="password" autocomplete="off" spellcheck="false" />
    </div>
    <div class="field">
      <label for="r2Secret">{{ t("credentials.r2SecretAccessKey") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
      <input id="r2Secret" v-model.trim="wizard.credentials.r2SecretAccessKey" type="password" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.r2KeyHelp") }}</p>
      <p v-if="!r2KeysComplete" class="field-help" style="color: var(--color-danger)">{{ t("credentials.r2KeysPairRequired") }}</p>
    </div>

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
    </template>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!canContinue" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
