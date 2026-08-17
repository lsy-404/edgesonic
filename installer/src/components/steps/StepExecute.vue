<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { runDeploy } from "../../lib/deploy/orchestrate";
import { DeployError, type DeployTarget } from "../../lib/deploy/types";
import { describeCfError } from "../../lib/cf/errors";

const { t } = useI18n();
const wizard = useWizard();

const running = ref(false);
const failedStep = ref("");
const failedMessage = ref("");

async function start() {
  wizard.resetExecution();
  running.value = true;
  failedStep.value = "";
  failedMessage.value = "";

  const release = wizard.localPackage || wizard.selectedRelease();
  if (!release) {
    failedStep.value = "download";
    failedMessage.value = t("execute.releaseUnavailable");
    wizard.setStepStatus("download", "failed", failedMessage.value);
    running.value = false;
    wizard.finishFailure();
    return;
  }

  const target: DeployTarget = {
    mode: wizard.mode,
    workerName: wizard.workerName.trim(),
    dbName: wizard.dbName.trim(),
    bucketName: wizard.bucketName.trim(),
    domain: wizard.domain.trim(),
    sourceRepo: wizard.sourceRepo.trim(),
    releaseTag: wizard.selectedTag,
    resetAdmin: wizard.resetAdmin,
    fullRebuild: wizard.fullRebuild,
    containerMode: wizard.containerMode,
    adminUsername: wizard.adminUsername.trim(),
    adminPassword: wizard.adminPassword,
  };

  try {
    const result = await runDeploy(wizard.credentials, target, release, (step, status, detail) => {
      wizard.setStepStatus(step, status, detail);
    });
    wizard.finishSuccess(result);
    wizard.step = 8;
  } catch (e) {
    if (e instanceof DeployError) {
      failedStep.value = e.step;
      failedMessage.value = describeCfError(e).message;
    } else {
      failedMessage.value = e instanceof Error ? e.message : String(e);
    }
    wizard.finishFailure();
  } finally {
    running.value = false;
  }
}

onMounted(start);

function retry() {
  void start();
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("execute.title") }}</h1>
    <p class="step-subtitle">{{ t("execute.subtitle") }}</p>

    <ul class="execute-steps">
      <li v-for="entry in wizard.stepStates" :key="entry.step" class="kv-row execute-step-row">
        <dt class="execute-step-label">
          <span class="status-dot" :class="`status-dot-${entry.status}`" />
          {{ t(`execute.steps.${entry.step}`) }}
        </dt>
        <dd>
          {{ t(`execute.status.${entry.status}`) }}
          <p v-if="entry.detail" class="field-help" style="margin: 4px 0 0">{{ entry.detail }}</p>
        </dd>
      </li>
    </ul>

    <div v-if="wizard.deployFailed" class="alert alert-danger" style="margin-top: 20px">
      <strong>{{ t("execute.failedTitle") }}</strong>
      <p style="margin: 6px 0 0">{{ t("execute.failedAt", { step: t(`execute.steps.${failedStep}`) }) }}</p>
      <p style="margin: 6px 0 0">{{ failedMessage }}</p>
    </div>

    <div class="step-actions" v-if="wizard.deployFailed && !running">
      <div class="spacer" />
      <button type="button" class="btn btn-primary" @click="retry">{{ t("common.retry") }}</button>
    </div>
    <p v-if="wizard.deployFailed" class="field-help">{{ t("execute.retryFromHere") }}</p>
  </div>
</template>
