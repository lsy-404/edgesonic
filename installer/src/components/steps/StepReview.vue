<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { DEFAULT_ADMIN_USERNAME } from "../../lib/deploy/admin";

const { t } = useI18n();
const wizard = useWizard();

function goNext() {
  wizard.resetExecution();
  wizard.step = 6;
}
function goBack() {
  wizard.step = 4;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("review.title") }}</h1>
    <p class="step-subtitle">{{ t("review.subtitle") }}</p>

    <div v-if="wizard.mode === 'overwrite'" class="alert alert-warning">
      <strong>{{ t("overwriteAdvice.title") }}</strong>
      <p>{{ t("overwriteAdvice.message") }}</p>
    </div>

    <dl class="kv-list">
      <div class="kv-row">
        <dt>{{ t("review.modeLabel") }}</dt>
        <dd>{{ wizard.mode === "fresh" ? t("review.modeFresh") : t("review.modeOverwrite") }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("review.accountLabel") }}</dt>
        <dd>{{ wizard.accountName || wizard.credentials.accountId }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("review.workerLabel") }}</dt>
        <dd>{{ wizard.workerName }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("review.dbLabel") }}</dt>
        <dd>{{ wizard.dbName }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("review.bucketLabel") }}</dt>
        <dd>{{ wizard.bucketName }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("review.domainLabel") }}</dt>
        <dd>{{ wizard.domain || t("review.domainNone") }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("review.versionLabel") }}</dt>
        <dd>{{ wizard.localPackage ? `${wizard.localPackage.manifest.tag} (${wizard.localPackage.fileName})` : wizard.selectedTag }}</dd>
      </div>
      <div class="kv-row">
        <dt>{{ t("review.containerLabel") }}</dt>
        <dd>{{ t(`target.container${wizard.containerMode === "deploy" ? "Deploy" : wizard.containerMode === "off" ? "Off" : "Keep"}`) }}</dd>
      </div>
      <div v-if="wizard.mode === 'overwrite'" class="kv-row">
        <dt>{{ t("review.fullRebuildLabel") }}</dt>
        <dd>{{ wizard.fullRebuild ? t("review.fullRebuildYes") : t("review.fullRebuildNo") }}</dd>
      </div>
      <div v-if="wizard.mode === 'overwrite'" class="kv-row">
        <dt>{{ t("review.adminResetLabel") }}</dt>
        <dd>{{ wizard.resetAdmin ? t("review.adminResetYes") : t("review.adminResetNo") }}</dd>
      </div>
      <div v-if="wizard.mode === 'fresh' || wizard.resetAdmin" class="kv-row">
        <dt>{{ t("review.adminUsernameLabel") }}</dt>
        <dd>{{ wizard.adminUsername.trim() || DEFAULT_ADMIN_USERNAME }}</dd>
      </div>
    </dl>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" @click="goNext">{{ t("review.confirm") }}</button>
    </div>
  </div>
</template>
