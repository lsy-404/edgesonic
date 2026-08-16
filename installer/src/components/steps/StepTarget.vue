<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { listScriptNames, scriptExists } from "../../lib/deploy/workerVersion";
import { listDatabaseNames } from "../../lib/deploy/d1";
import { listBucketNames } from "../../lib/deploy/r2";
import { callCfJson } from "../../lib/relay";
import { describeCfError } from "../../lib/cf/errors";

const { t } = useI18n();
const wizard = useWizard();

const collision = ref<boolean | null>(null);
const checkingCollision = ref(false);
const discovering = ref(false);
const discoveryFailed = ref(false);
const suspectedWorkers = ref<string[]>([]);
const suspectedDatabases = ref<string[]>([]);
const suspectedBuckets = ref<string[]>([]);
const hasSuspectedResources = computed(
  () => suspectedWorkers.value.length + suspectedDatabases.value.length + suspectedBuckets.value.length > 0,
);
const looksLikeEdgeSonic = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "").includes("edgesonic");
let collisionGeneration = 0;

async function checkCollision() {
  if (!wizard.credentials.accountId || !wizard.credentials.apiToken || !wizard.workerName.trim()) return;
  const generation = ++collisionGeneration;
  const workerName = wizard.workerName.trim();
  checkingCollision.value = true;
  try {
    const exists = await scriptExists(wizard.credentials.apiToken, wizard.credentials.accountId, workerName);
    if (generation === collisionGeneration && wizard.workerName.trim() === workerName) collision.value = exists;
  } catch {
    if (generation === collisionGeneration) collision.value = null;
  } finally {
    if (generation === collisionGeneration) checkingCollision.value = false;
  }
}

onMounted(checkCollision);
onMounted(async () => {
  if (wizard.mode !== "overwrite") return;
  discovering.value = true;
  discoveryFailed.value = false;
  try {
    const [workers, databases, buckets] = await Promise.all([
      listScriptNames(wizard.credentials.apiToken, wizard.credentials.accountId),
      listDatabaseNames(wizard.credentials.apiToken, wizard.credentials.accountId),
      listBucketNames(wizard.credentials.apiToken, wizard.credentials.accountId),
    ]);
    suspectedWorkers.value = workers.filter(looksLikeEdgeSonic);
    suspectedDatabases.value = databases.filter(looksLikeEdgeSonic);
    suspectedBuckets.value = buckets.filter(looksLikeEdgeSonic);
  } catch {
    discoveryFailed.value = true;
  } finally {
    discovering.value = false;
  }
});

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

function selectResource(kind: "worker" | "database" | "bucket", name: string) {
  if (kind === "worker") wizard.workerName = name;
  else if (kind === "database") wizard.dbName = name;
  else wizard.bucketName = name;
}

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
    ? collision.value !== true
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

    <div v-if="wizard.mode === 'overwrite'" class="guide-card">
      <h3>{{ t("target.discoveryTitle") }}</h3>
      <p v-if="discovering">{{ t("target.discoveryChecking") }}</p>
      <p v-else-if="discoveryFailed" class="field-help">{{ t("target.discoveryFailed") }}</p>
      <p v-else-if="!hasSuspectedResources" class="field-help">{{ t("target.discoveryNone") }}</p>
      <template v-else>
        <p class="field-help">{{ t("target.discoveryFound") }}</p>
        <div v-if="suspectedWorkers.length" class="field">
          <label>{{ t("target.suspectedWorkers") }}</label>
          <button v-for="name in suspectedWorkers" :key="name" type="button" class="btn btn-secondary" @click="selectResource('worker', name)">{{ name }}</button>
        </div>
        <div v-if="suspectedDatabases.length" class="field">
          <label>{{ t("target.suspectedDatabases") }}</label>
          <button v-for="name in suspectedDatabases" :key="name" type="button" class="btn btn-secondary" @click="selectResource('database', name)">{{ name }}</button>
        </div>
        <div v-if="suspectedBuckets.length" class="field">
          <label>{{ t("target.suspectedBuckets") }}</label>
          <button v-for="name in suspectedBuckets" :key="name" type="button" class="btn btn-secondary" @click="selectResource('bucket', name)">{{ name }}</button>
        </div>
      </template>
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
      <span>{{ t("target.overwriteConfirm") }}</span>
    </label>

    <div class="field">
      <label for="dbName">D1 — {{ t("target.dbNameHelp") }}</label>
      <input id="dbName" v-model.trim="wizard.dbName" type="text" spellcheck="false" />
    </div>

    <div class="field">
      <label for="bucketName">R2 — {{ t("target.bucketNameHelp") }}</label>
      <input id="bucketName" v-model.trim="wizard.bucketName" type="text" spellcheck="false" />
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
