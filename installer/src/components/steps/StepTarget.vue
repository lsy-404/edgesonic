<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { scriptExists } from "../../lib/deploy/workerVersion";
import { callCfJson } from "../../lib/relay";
import { describeCfError } from "../../lib/cf/errors";

const { t } = useI18n();
const wizard = useWizard();

const collision = ref<boolean | null>(null);
const checkingCollision = ref(false);

async function checkCollision() {
  if (!wizard.credentials.accountId || !wizard.credentials.apiToken || !wizard.workerName.trim()) return;
  checkingCollision.value = true;
  try {
    collision.value = await scriptExists(wizard.credentials.apiToken, wizard.credentials.accountId, wizard.workerName.trim());
  } catch {
    collision.value = null;
  } finally {
    checkingCollision.value = false;
  }
}

onMounted(checkCollision);

interface ZoneLookup {
  status: "idle" | "checking" | "found" | "not-found";
  zoneName: string;
}
const zoneLookup = ref<ZoneLookup>({ status: "idle", zoneName: "" });
let zoneLookupTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => wizard.domain,
  (value) => {
    clearTimeout(zoneLookupTimer);
    const domain = value.trim();
    if (!domain) {
      zoneLookup.value = { status: "idle", zoneName: "" };
      return;
    }
    zoneLookupTimer = setTimeout(async () => {
      zoneLookup.value = { status: "checking", zoneName: "" };
      try {
        const result = await callCfJson<Array<{ name?: string }>>(
          wizard.credentials.apiToken,
          `/zones?name=${encodeURIComponent(domain)}`,
          undefined,
          "Zone Read",
        );
        if (result.length > 0) {
          zoneLookup.value = { status: "found", zoneName: result[0].name || domain };
        } else {
          zoneLookup.value = { status: "not-found", zoneName: "" };
        }
      } catch (e) {
        zoneLookup.value = { status: "not-found", zoneName: describeCfError(e).message };
      }
    }, 600);
  },
);

const canContinue = () => wizard.workerName.trim().length > 0 && !(wizard.mode === "fresh" && collision.value === true);

function goNext() {
  wizard.step = 6;
}
function goBack() {
  wizard.step = 4;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("target.title") }}</h1>
    <p class="step-subtitle">{{ t("target.subtitle") }}</p>

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
    </div>

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
    </div>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!canContinue()" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
