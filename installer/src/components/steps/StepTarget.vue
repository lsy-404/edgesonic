<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { scriptExists } from "../../lib/deploy/workerVersion";
import { listDatabaseNames } from "../../lib/deploy/d1";
import { listBucketNames } from "../../lib/deploy/r2";
import { ADMIN_USERNAME_RE } from "../../lib/deploy/admin";
import { callCfJson } from "../../lib/relay";
import { describeCfError } from "../../lib/cf/errors";
import { WinButton, WinCheckBox, WinProgressRing } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

// Everything this page states about the account is fetched once behind a cover,
// so the Worker, D1 and R2 answers land together instead of rewriting the form
// under the user as each one arrives.
const scanning = ref(true);

const collision = ref<boolean | null>(null);
const checkingCollision = ref(false);
let collisionGeneration = 0;

async function checkCollision() {
  if (!wizard.credentials.accountId || !wizard.credentials.apiToken || !wizard.workerName.trim()) return;
  const generation = ++collisionGeneration;
  const workerName = wizard.workerName.trim();
  checkingCollision.value = true;
  try {
    const exists = await scriptExists(wizard.credentials.apiToken, wizard.credentials.accountId, workerName);
    if (generation === collisionGeneration && wizard.workerName.trim() === workerName) {
      collision.value = exists;
      wizard.mode = exists ? "overwrite" : "fresh";
    }
  } catch {
    if (generation === collisionGeneration) collision.value = null;
  } finally {
    if (generation === collisionGeneration) checkingCollision.value = false;
  }
}

let collisionTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => wizard.workerName,
  () => {
    collisionGeneration++;
    collision.value = null;
    wizard.overwriteConfirmed = false;
    clearTimeout(collisionTimer);
    collisionTimer = setTimeout(checkCollision, 400);
  },
);
onUnmounted(() => {
  collisionGeneration++;
  clearTimeout(collisionTimer);
});

// Whether the D1 database and R2 bucket exist is stated in every deploy mode
// and never gates anything: a fresh install silently reuses a same-named
// resource (see getOrCreateDatabase/getOrCreateBucket) and a recovery needs to
// know its library is still there.
type ResourceState = "checking" | "exists" | "absent" | "unknown";

const ADOPT_KEYWORD = "edgesonic";

function defaultResourceName(suffix: string): string {
  return `${wizard.workerName.trim() || "edgesonic"}-${suffix}`;
}

// An account that already ran EdgeSonic usually holds its library under a name
// the defaults don't guess, so an untouched field starts from what is actually
// there instead of creating an empty resource beside it.
function adoptExisting(names: string[], current: string, suffix: string): string {
  if (names.includes(current) || current !== defaultResourceName(suffix)) return current;
  const worker = wizard.workerName.trim().toLowerCase();
  const matches = names.filter((name) => name.toLowerCase().includes(ADOPT_KEYWORD));
  return matches.find((name) => name.toLowerCase().startsWith(worker)) || matches[0] || current;
}

function useResourceCheck(
  list: (token: string, accountId: string) => Promise<string[]>,
  read: () => string,
  write: (value: string) => void,
  suffix: string,
) {
  const state = ref<ResourceState>("checking");
  const adopted = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = "";

  function apply(names: string[] | null, name: string) {
    if (!names) {
      state.value = "unknown";
      return;
    }
    settled = name;
    state.value = names.includes(name) ? "exists" : "absent";
  }

  function prime(names: string[] | null) {
    const current = read().trim();
    const chosen = names ? adoptExisting(names, current, suffix) : current;
    adopted.value = chosen !== current;
    if (adopted.value) write(chosen);
    apply(names, chosen);
  }

  // Simple debounce, no generation tracking: worst case a stale response
  // briefly shows against a since-edited field, corrected by the next keystroke.
  watch(read, (value) => {
    clearTimeout(timer);
    const name = value.trim();
    if (name === settled) return;
    adopted.value = false;
    if (!name || !wizard.credentials.accountId || !wizard.credentials.apiToken) {
      state.value = "unknown";
      return;
    }
    state.value = "checking";
    timer = setTimeout(async () => {
      const names = await list(wizard.credentials.apiToken, wizard.credentials.accountId).catch(() => null);
      if (read().trim() === name) apply(names, name);
    }, 500);
  });

  onUnmounted(() => clearTimeout(timer));
  return { state, adopted, prime };
}

const { state: dbState, adopted: dbAdopted, prime: primeDb } =
  useResourceCheck(listDatabaseNames, () => wizard.dbName, (value) => { wizard.dbName = value; }, "db");
const { state: bucketState, adopted: bucketAdopted, prime: primeBucket } =
  useResourceCheck(listBucketNames, () => wizard.bucketName, (value) => { wizard.bucketName = value; }, "storage");

onMounted(async () => {
  const { accountId, apiToken } = wizard.credentials;
  const [databases, buckets] = await Promise.all([
    listDatabaseNames(apiToken, accountId).catch(() => null),
    listBucketNames(apiToken, accountId).catch(() => null),
    checkCollision(),
  ]);
  primeDb(databases);
  primeBucket(buckets);
  scanning.value = false;
});

const adminSetupApplies = computed(() => wizard.mode === "fresh" || wizard.resetAdmin);
const adminUsernameValid = computed(() => !wizard.adminUsername.trim() || ADMIN_USERNAME_RE.test(wizard.adminUsername.trim()));

interface ZoneLookup {
  status: "idle" | "checking" | "found" | "not-found";
  zoneName: string;
  zoneId: string;
}
const zoneLookup = ref<ZoneLookup>({ status: "idle", zoneName: "", zoneId: "" });
const transformations = ref<"idle" | "checking" | "on" | "off" | "unavailable">("idle");
let zoneLookupTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => wizard.domain,
  (value) => {
    clearTimeout(zoneLookupTimer);
    const domain = value.trim();
    if (!domain) {
      zoneLookup.value = { status: "idle", zoneName: "", zoneId: "" };
      transformations.value = "idle";
      return;
    }
    zoneLookupTimer = setTimeout(async () => {
        zoneLookup.value = { status: "checking", zoneName: "", zoneId: "" };
      try {
        const result = await callCfJson<Array<{ id?: string; name?: string }>>(
          wizard.credentials.apiToken,
          `/zones?name=${encodeURIComponent(domain)}`,
          undefined,
          "Zone Read",
        );
        if (result.length > 0) {
          const zone = result[0];
          zoneLookup.value = { status: "found", zoneName: zone.name || domain, zoneId: zone.id || "" };
          if (!zone.id) {
            transformations.value = "unavailable";
            return;
          }
          transformations.value = "checking";
          try {
            const setting = await callCfJson<{ value?: string }>(
              wizard.credentials.apiToken,
              `/zones/${zone.id}/settings/image_resizing`,
              undefined,
              "Zone Settings Read",
            );
            transformations.value = setting.value === "on" ? "on" : "off";
          } catch {
            transformations.value = "unavailable";
          }
        } else {
          zoneLookup.value = { status: "not-found", zoneName: "", zoneId: "" };
          transformations.value = "idle";
        }
      } catch (e) {
        zoneLookup.value = { status: "not-found", zoneName: describeCfError(e).message, zoneId: "" };
        transformations.value = "idle";
      }
    }, 600);
  },
);

const canContinue = () => wizard.workerName.trim().length > 0
  && (wizard.mode === "fresh"
    ? collision.value === false
    : collision.value === true && wizard.overwriteConfirmed);

function goNext() {
  wizard.step = 4;
}
function goBack() {
  wizard.step = 2;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("target.title") }}</h1>
    <p class="step-subtitle">{{ t("target.subtitle") }}</p>

    <div v-if="scanning" class="account-scan">
      <WinProgressRing :Width="20" :Height="20" :IsActive="true" />
      <span>{{ t("target.scanning") }}</span>
    </div>

    <template v-else>
      <div class="field">
        <label for="workerName">{{ t("target.workerName") }}</label>
        <input id="workerName" v-model.trim="wizard.workerName" type="text" spellcheck="false" @blur="checkCollision" />
        <p class="field-help">{{ t("target.workerNameHelp") }}</p>
        <p v-if="collision === true && wizard.mode === 'fresh'" class="field-help" style="color: var(--SystemFillColorCriticalBrush)">
          {{ t("target.collisionWarning", { name: wizard.workerName }) }}
        </p>
        <p v-else-if="collision === true && wizard.mode === 'overwrite'" class="field-help" style="color: var(--SystemFillColorSuccessBrush)">
          {{ t("target.collisionOkOverwrite", { name: wizard.workerName }) }}
        </p>
        <p v-else-if="wizard.mode === 'overwrite' && collision === false" class="field-help" style="color: var(--SystemFillColorCriticalBrush)">
          {{ t("target.overwriteMissing", { name: wizard.workerName }) }}
        </p>
      </div>

      <WinCheckBox v-if="wizard.mode === 'overwrite' && collision === true" v-model="wizard.overwriteConfirmed">
        <span><span class="required-star" aria-hidden="true">*</span>{{ t("target.overwriteConfirm") }}</span>
      </WinCheckBox>
      <WinCheckBox v-if="wizard.mode === 'overwrite' && collision === true" v-model="wizard.resetAdmin">
        {{ t("target.resetAdmin") }}
      </WinCheckBox>
      <WinCheckBox v-if="wizard.mode === 'overwrite' && collision === true && wizard.overwriteConfirmed" v-model="wizard.fullRebuild">
        {{ t("target.fullRebuild") }}
      </WinCheckBox>
      <p v-if="wizard.fullRebuild" class="field-help" style="color: var(--SystemFillColorCautionBrush)">{{ t("target.fullRebuildHelp") }}</p>
      <div class="field">
        <label for="containerMode">{{ t("target.containerMode") }}</label>
        <select id="containerMode" v-model="wizard.containerMode">
          <option value="keep">{{ t("target.containerKeep") }}</option>
          <option value="deploy">{{ t("target.containerDeploy") }}</option>
          <option value="off">{{ t("target.containerOff") }}</option>
        </select>
        <p class="field-help">{{ t("target.containerModeHelp") }}</p>
      </div>

      <!-- A recovery that keeps its superadmin ignores both fields (see the
           deploy's admin step), so they are only offered where they apply. -->
      <template v-if="adminSetupApplies">
        <div class="field">
          <label for="adminUsername">{{ t("target.adminUsername") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
          <input id="adminUsername" v-model.trim="wizard.adminUsername" type="text" autocomplete="off" spellcheck="false" placeholder="admin" />
          <p class="field-help">{{ t("target.adminUsernameHelp") }}</p>
          <p v-if="!adminUsernameValid" class="field-help" style="color: var(--SystemFillColorCautionBrush)">{{ t("target.adminUsernameInvalid") }}</p>
        </div>

        <div class="field">
          <label for="adminPassword">{{ t("target.adminPassword") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
          <input id="adminPassword" v-model="wizard.adminPassword" type="password" autocomplete="new-password" spellcheck="false" />
          <p class="field-help">{{ t("target.adminPasswordHelp") }}</p>
        </div>
      </template>

      <div class="field">
        <label for="dbName">D1 — {{ t("target.dbNameHelp") }}</label>
        <input id="dbName" v-model.trim="wizard.dbName" type="text" spellcheck="false" />
        <p v-if="dbAdopted" class="field-help tone-ok">{{ t("target.dbAdopted", { name: wizard.dbName }) }}</p>
        <p v-if="dbState === 'checking'" class="field-help">{{ t("target.resourceChecking") }}</p>
        <p v-else-if="dbState === 'unknown'" class="field-help tone-warn">{{ t("target.dbUnknown", { name: wizard.dbName }) }}</p>
        <p v-else-if="dbState === 'exists'" class="field-help" :class="wizard.mode === 'fresh' ? 'tone-warn' : 'tone-ok'">
          {{ wizard.mode === "fresh" ? t("target.dbCollisionWarning", { name: wizard.dbName }) : t("target.dbExists", { name: wizard.dbName }) }}
        </p>
        <p v-else class="field-help" :class="wizard.mode === 'fresh' ? '' : 'tone-warn'">{{ t("target.dbAbsent", { name: wizard.dbName }) }}</p>
      </div>

      <div class="field">
        <label for="bucketName">R2 — {{ t("target.bucketNameHelp") }}</label>
        <input id="bucketName" v-model.trim="wizard.bucketName" type="text" spellcheck="false" />
        <p v-if="bucketAdopted" class="field-help tone-ok">{{ t("target.bucketAdopted", { name: wizard.bucketName }) }}</p>
        <p v-if="bucketState === 'checking'" class="field-help">{{ t("target.resourceChecking") }}</p>
        <p v-else-if="bucketState === 'unknown'" class="field-help tone-warn">{{ t("target.bucketUnknown", { name: wizard.bucketName }) }}</p>
        <p v-else-if="bucketState === 'exists'" class="field-help" :class="wizard.mode === 'fresh' ? 'tone-warn' : 'tone-ok'">
          {{ wizard.mode === "fresh" ? t("target.bucketCollisionWarning", { name: wizard.bucketName }) : t("target.bucketExists", { name: wizard.bucketName }) }}
        </p>
        <p v-else class="field-help" :class="wizard.mode === 'fresh' ? '' : 'tone-warn'">{{ t("target.bucketAbsent", { name: wizard.bucketName }) }}</p>
      </div>

      <div class="field">
        <label for="domain">{{ t("target.domain") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
        <input id="domain" v-model.trim="wizard.domain" type="text" :placeholder="t('target.domainPlaceholder')" spellcheck="false" />
        <p class="field-help">{{ t("target.domainHelp") }}</p>
        <p v-if="zoneLookup.status === 'found'" class="field-help" style="color: var(--SystemFillColorSuccessBrush)">{{ t("target.domainZoneFound", { zone: zoneLookup.zoneName }) }}</p>
        <p v-else-if="zoneLookup.status === 'not-found'" class="field-help" style="color: var(--SystemFillColorCautionBrush)">{{ t("target.domainZoneNotFound", { domain: wizard.domain }) }}</p>
        <p v-if="transformations === 'checking'" class="field-help">{{ t("target.transformationsChecking") }}</p>
        <p v-else-if="transformations === 'on'" class="field-help" style="color: var(--SystemFillColorSuccessBrush)">{{ t("target.transformationsOn") }}</p>
        <template v-else-if="transformations === 'off'">
          <p class="field-help" style="color: var(--SystemFillColorCautionBrush)">{{ t("target.transformationsOff") }}</p>
          <a :href="`https://dash.cloudflare.com/${wizard.credentials.accountId}/images/transformations`" target="_blank" rel="noreferrer">{{ t("target.transformationsLink") }} ↗</a>
        </template>
        <p v-else-if="transformations === 'unavailable'" class="field-help">{{ t("target.transformationsUnavailable") }}</p>
      </div>
    </template>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="goBack">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="canContinue()" @Click="goNext">{{ t("common.next") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.account-scan {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-secondary);
  padding: 24px 0;
}

.field-help.tone-ok {
  color: var(--SystemFillColorSuccessBrush);
}

.field-help.tone-warn {
  color: var(--SystemFillColorCautionBrush);
}
</style>
