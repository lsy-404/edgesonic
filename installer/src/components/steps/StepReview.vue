<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { DEFAULT_ADMIN_USERNAME } from "../../lib/deploy/admin";
import { WinButton } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

const CONFIRM_LOCK_SECONDS = 3;
const lockSecondsLeft = ref(CONFIRM_LOCK_SECONDS);
let lockTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  lockTimer = setInterval(() => {
    lockSecondsLeft.value -= 1;
    if (lockSecondsLeft.value <= 0) clearInterval(lockTimer);
  }, 1000);
});
onUnmounted(() => clearInterval(lockTimer));

function goNext() {
  wizard.resetExecution();
  wizard.step = 7;
}
function goBack() {
  wizard.step = 5;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("review.title") }}</h1>
    <p class="step-subtitle">{{ t("review.subtitle") }}</p>

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
        <dd>{{ wizard.selectedTag }}</dd>
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

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="goBack">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="lockSecondsLeft <= 0" @Click="goNext">
          {{ lockSecondsLeft > 0 ? t("review.confirmWait", { seconds: lockSecondsLeft }) : t("review.confirm") }}
        </WinButton>
      </div>
    </Teleport>
  </div>
</template>
