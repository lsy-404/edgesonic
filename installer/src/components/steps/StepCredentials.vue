<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { callCfJson, verifyR2Keys } from "../../lib/relay";
import { listBucketNames } from "../../lib/deploy/r2";
import { describeCfError } from "../../lib/cf/errors";
import { hasTokenPermission, readTokenPermissionGroups, TOKEN_PERMISSION_GROUPS } from "../../lib/cf/tokenPolicies";
import { WinButton } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();
// Only the three resources the deploy writes to are gates. Reading the token's
// own policies just makes the table exact — without it every optional row is
// unknown, which is a worse experience, not a blocked deployment.
const permissionRows = [
  { key: "apiTokens", category: "account", requirement: "recommended", scope: "account", level: "read" },
  { key: "scripts", category: "developer", requirement: "required", scope: "account", level: "write" },
  { key: "d1", category: "developer", requirement: "required", scope: "account", level: "write" },
  { key: "r2", category: "developer", requirement: "required", scope: "account", level: "write" },
  { key: "r2Keys", category: "developer", requirement: "optional", scope: "allBuckets", level: "readWrite" },
  { key: "ci", category: "developer", requirement: "optional", scope: "account", level: "write" },
  { key: "containers", category: "developer", requirement: "optional", scope: "account", level: "write" },
  { key: "observability", category: "analytics", requirement: "optional", scope: "account", level: "write" },
  { key: "accountAnalytics", category: "analytics", requirement: "optional", scope: "account", level: "read" },
  { key: "accountSettings", category: "account", requirement: "optional", scope: "account", level: "read" },
] as const;

const verifying = ref(false);
const hasAttempted = ref(false);

type CheckStatus = "pending" | "checking" | "ok" | "missing" | "unknown" | "error";
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

function checkFor(key: string): PermissionCheck | undefined {
  return checks.find((c) => c.key === key);
}

const tokenCheck = computed(() => checkFor("token"));

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

const requiredCheckKeys = new Set(["token", "scripts", "d1", "r2"]);
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

  // A token that can read its own policies states every permission it holds,
  // which settles the whole table in one call.
  let policiesRead = false;
  try {
    setCheck("apiTokens", "checking");
    const groups = await readTokenPermissionGroups(apiToken, accountId, tokenId);
    if (isStale()) return;
    for (const key of Object.keys(TOKEN_PERMISSION_GROUPS) as Array<keyof typeof TOKEN_PERMISSION_GROUPS>) {
      setCheck(key, hasTokenPermission(groups, key) ? "ok" : "missing");
    }
    policiesRead = true;
    wizard.r2Enabled = hasTokenPermission(groups, "r2");
  } catch (e) {
    if (isStale()) return;
    const context = describeCfError(e, "Account API Tokens Read").message;
    setCheck("apiTokens", "missing", context);
    // Every optional permission is now unprovable: probing them costs a request
    // each and the deploy never needs them. The three below are probed because
    // they decide whether the deploy can run at all.
    for (const key of Object.keys(TOKEN_PERMISSION_GROUPS)) {
      if (key !== "apiTokens") setCheck(key, "unknown", t("credentials.unknownWithoutPolicies"));
    }
  }

  wizard.accountName = accountId;

  // Fallback only: probing each API costs a request per permission and is the
  // only way left to tell what a token holds once its policies are unreadable.
  if (!policiesRead) {
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
    } catch (e) {
      if (isStale()) return;
      const described = describeCfError(e, "Workers R2 Storage Edit");
      setCheck("r2", described.r2NotSubscribed ? "missing" : "error", described.r2NotSubscribed ? t("credentials.r2NotEnabled") : described.message);
      wizard.r2Enabled = false;
    }
  }

  // The R2 access keys are S3 credentials of their own, so neither the token's
  // policies nor any probe above says anything about them.
  if (wizard.r2Enabled === true) {
    const { r2AccessKeyId, r2SecretAccessKey } = wizard.credentials;
    if (r2AccessKeyId && r2SecretAccessKey) {
      setCheck("r2Keys", "checking");
      try {
        const r2Keys = await verifyR2Keys({ accountId, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey });
        if (isStale()) return;
        setCheck("r2Keys", r2Keys.ok ? "ok" : "missing", r2Keys.ok ? "" : t("credentials.r2KeyInvalid"));
      } catch {
        if (isStale()) return;
        setCheck("r2Keys", "error", t("credentials.r2KeyInvalid"));
      }
    } else {
      setCheck("r2Keys", "pending", t("credentials.r2KeysOptionalSkipped"));
    }
  } else {
    setCheck("r2Keys", "pending");
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
                  <th>{{ t("credentials.permissionCategory") }}</th>
                  <th>{{ t("credentials.permissionResource") }}</th>
                  <th>{{ t("credentials.permissionRequired") }}</th>
                  <th>{{ t("credentials.permissionScenario") }}</th>
                  <th>{{ t("credentials.permissionScope") }}</th>
                  <th>{{ t("credentials.permissionLevel") }}</th>
                  <th>{{ t("credentials.permissionStatus") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="permission in permissionRows" :key="permission.key">
                  <td>{{ t(`credentials.permissionCategories.${permission.category}`) }}</td>
                  <td>{{ t(`credentials.permissions.${permission.key}.resource`) }}</td>
                  <td>
                    <span :class="`requirement-${permission.requirement}`">{{ t(`credentials.requirements.${permission.requirement}`) }}</span>
                  </td>
                  <td>{{ t(`credentials.permissions.${permission.key}.scenario`) }}</td>
                  <td>{{ t(`credentials.permissionScopes.${permission.scope}`) }}</td>
                  <td>{{ t(`credentials.permissionLevels.${permission.level}`) }}</td>
                  <td>
                    <span v-if="hasAttempted" class="check-status" :title="checkFor(permission.key)?.detail || ''">
                      <span class="check-dot" :class="`check-dot-${checkFor(permission.key)?.status || 'pending'}`" aria-hidden="true" />
                      {{ t(`credentials.checkStatus.${checkFor(permission.key)?.status || 'pending'}`) }}
                    </span>
                    <span v-else class="check-status">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="hasAttempted" class="field-help check-status">
            <span class="check-dot" :class="`check-dot-${tokenCheck?.status || 'pending'}`" aria-hidden="true" />
            {{ t("credentials.checks.token") }}: {{ t(`credentials.checkStatus.${tokenCheck?.status || 'pending'}`) }}
            <template v-if="tokenCheck?.detail">— {{ tokenCheck.detail }}</template>
          </p>
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
      <input id="apiToken" v-model.trim="wizard.credentials.apiToken" type="text" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.apiTokenHelp") }}</p>
      <p class="field-help">{{ t("credentials.apiTokenStorageNote") }}</p>
    </div>

    <div class="field">
      <label for="r2Key">{{ t("credentials.r2AccessKeyId") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
      <input id="r2Key" v-model.trim="wizard.credentials.r2AccessKeyId" type="text" autocomplete="off" spellcheck="false" />
    </div>
    <div class="field">
      <label for="r2Secret">{{ t("credentials.r2SecretAccessKey") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
      <input id="r2Secret" v-model.trim="wizard.credentials.r2SecretAccessKey" type="text" autocomplete="off" spellcheck="false" />
      <p class="field-help">{{ t("credentials.r2KeyHelp") }}</p>
      <p v-if="!r2KeysComplete" class="field-help" style="color: var(--SystemFillColorCriticalBrush)">{{ t("credentials.r2KeysPairRequired") }}</p>
    </div>

    <template v-if="wizard.credentialsVerified">
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

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="goBack">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="canContinue" @Click="goNext">{{ t("common.next") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>
