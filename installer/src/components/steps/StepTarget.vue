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

const { t } = useI18n();
const wizard = useWizard();

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

onMounted(checkCollision);

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

// Advisory only — a fresh install silently reuses an existing D1
// database/R2 bucket of the same name (see getOrCreateDatabase/getOrCreateBucket),
// so this just surfaces that risk to the user instead of gating anything.
// Simple debounce, no generation tracking: worst case a stale response
// briefly shows against a since-edited field, corrected by the next keystroke.
const dbCollision = ref<boolean | null>(null);
const bucketCollision = ref<boolean | null>(null);
let dbCollisionTimer: ReturnType<typeof setTimeout> | undefined;
let bucketCollisionTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => wizard.dbName,
  (value) => {
    clearTimeout(dbCollisionTimer);
    const name = value.trim();
    if (!name || !wizard.credentials.accountId || !wizard.credentials.apiToken) {
      dbCollision.value = null;
      return;
    }
    dbCollisionTimer = setTimeout(async () => {
      try {
        const names = await listDatabaseNames(wizard.credentials.apiToken, wizard.credentials.accountId);
        if (wizard.dbName.trim() === name) dbCollision.value = names.includes(name);
      } catch {
        if (wizard.dbName.trim() === name) dbCollision.value = null;
      }
    }, 500);
  },
  { immediate: true },
);

watch(
  () => wizard.bucketName,
  (value) => {
    clearTimeout(bucketCollisionTimer);
    const name = value.trim();
    if (!name || !wizard.credentials.accountId || !wizard.credentials.apiToken) {
      bucketCollision.value = null;
      return;
    }
    bucketCollisionTimer = setTimeout(async () => {
      try {
        const names = await listBucketNames(wizard.credentials.apiToken, wizard.credentials.accountId);
        if (wizard.bucketName.trim() === name) bucketCollision.value = names.includes(name);
      } catch {
        if (wizard.bucketName.trim() === name) bucketCollision.value = null;
      }
    }, 500);
  },
  { immediate: true },
);

onUnmounted(() => {
  clearTimeout(dbCollisionTimer);
  clearTimeout(bucketCollisionTimer);
});

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

    <div v-if="wizard.mode === 'overwrite'" class="alert alert-warning">
      <strong>{{ t("overwriteAdvice.title") }}</strong>
      <p>{{ t("overwriteAdvice.message") }}</p>
    </div>

    <div class="field">
      <label for="workerName">{{ t("target.workerName") }}</label>
      <input id="workerName" v-model.trim="wizard.workerName" type="text" spellcheck="false" @blur="checkCollision" />
      <p class="field-help">{{ t("target.workerNameHelp") }}</p>
      <p v-if="collision === true && wizard.mode === 'fresh'" class="field-help" style="color: var(--color-danger)">
        {{ t("target.collisionWarning", { name: wizard.workerName }) }}
      </p>
      <p v-else-if="collision === true && wizard.mode === 'overwrite'" class="field-help" style="color: var(--color-success)">
        {{ t("target.collisionOkOverwrite", { name: wizard.workerName }) }}
      </p>
      <p v-else-if="wizard.mode === 'overwrite' && collision === false" class="field-help" style="color: var(--color-danger)">
        {{ t("target.overwriteMissing", { name: wizard.workerName }) }}
      </p>
    </div>

    <label v-if="wizard.mode === 'overwrite' && collision === true" class="check-row">
      <input v-model="wizard.overwriteConfirmed" type="checkbox" />
      <span>{{ t("target.overwriteConfirm") }}<span class="required-star" aria-hidden="true">*</span></span>
    </label>
    <label v-if="wizard.mode === 'overwrite' && collision === true" class="check-row">
      <input v-model="wizard.resetAdmin" type="checkbox" />
      <span>{{ t("target.resetAdmin") }}</span>
    </label>
    <label v-if="wizard.mode === 'overwrite' && collision === true && wizard.overwriteConfirmed" class="check-row">
      <input v-model="wizard.fullRebuild" type="checkbox" />
      <span>{{ t("target.fullRebuild") }}</span>
    </label>
    <p v-if="wizard.fullRebuild" class="field-help" style="color: var(--color-warning)">{{ t("target.fullRebuildHelp") }}</p>

    <div class="field">
      <label for="adminUsername">{{ t("target.adminUsername") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
      <input id="adminUsername" v-model.trim="wizard.adminUsername" type="text" autocomplete="off" spellcheck="false" placeholder="admin" />
      <p class="field-help">{{ t("target.adminUsernameHelp") }}</p>
      <p v-if="!adminUsernameValid" class="field-help" style="color: var(--color-warning)">{{ t("target.adminUsernameInvalid") }}</p>
    </div>

    <div class="field">
      <label for="adminPassword">{{ t("target.adminPassword") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
      <input id="adminPassword" v-model="wizard.adminPassword" type="password" autocomplete="new-password" spellcheck="false" />
      <p class="field-help">{{ t("target.adminPasswordHelp") }}</p>
    </div>

    <div class="field">
      <label for="dbName">D1 — {{ t("target.dbNameHelp") }}</label>
      <input id="dbName" v-model.trim="wizard.dbName" type="text" spellcheck="false" />
      <p v-if="wizard.mode === 'fresh' && dbCollision === true" class="field-help" style="color: var(--color-warning)">
        {{ t("target.dbCollisionWarning", { name: wizard.dbName }) }}
      </p>
    </div>

    <div class="field">
      <label for="bucketName">R2 — {{ t("target.bucketNameHelp") }}</label>
      <input id="bucketName" v-model.trim="wizard.bucketName" type="text" spellcheck="false" />
      <p v-if="wizard.mode === 'fresh' && bucketCollision === true" class="field-help" style="color: var(--color-warning)">
        {{ t("target.bucketCollisionWarning", { name: wizard.bucketName }) }}
      </p>
    </div>

    <div class="field">
      <label for="domain">{{ t("target.domain") }}<span class="field-tag optional">{{ t("common.optional") }}</span></label>
      <input id="domain" v-model.trim="wizard.domain" type="text" :placeholder="t('target.domainPlaceholder')" spellcheck="false" />
      <p class="field-help">{{ t("target.domainHelp") }}</p>
      <p v-if="zoneLookup.status === 'found'" class="field-help" style="color: var(--color-success)">{{ t("target.domainZoneFound", { zone: zoneLookup.zoneName }) }}</p>
      <p v-else-if="zoneLookup.status === 'not-found'" class="field-help" style="color: var(--color-warning)">{{ t("target.domainZoneNotFound", { domain: wizard.domain }) }}</p>
      <p v-if="transformations === 'checking'" class="field-help">{{ t("target.transformationsChecking") }}</p>
      <p v-else-if="transformations === 'on'" class="field-help" style="color: var(--color-success)">{{ t("target.transformationsOn") }}</p>
      <template v-else-if="transformations === 'off'">
        <p class="field-help" style="color: var(--color-warning)">{{ t("target.transformationsOff") }}</p>
        <a :href="`https://dash.cloudflare.com/${wizard.credentials.accountId}/images/transformations`" target="_blank" rel="noreferrer">{{ t("target.transformationsLink") }} ↗</a>
      </template>
      <p v-else-if="transformations === 'unavailable'" class="field-help">{{ t("target.transformationsUnavailable") }}</p>
    </div>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!canContinue()" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
