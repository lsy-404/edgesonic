<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { runDeploy } from "../../lib/deploy/orchestrate";
import { DeployError, type DeployTarget } from "../../lib/deploy/types";
import { describeCfError } from "../../lib/cf/errors";
import { FluentButton, FluentNotice, FluentProgressBar, FluentProgressRing } from "@lsypkg/fluent/vue";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  const release = wizard.selectedRelease();
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
    releaseTag: wizard.selectedTag,
    resetAdmin: wizard.resetAdmin,
    fullRebuild: wizard.fullRebuild,
    containerMode: wizard.containerMode,
    adminUsername: wizard.adminUsername.trim(),
    adminPassword: wizard.adminPassword,
  };

  try {
    const result = await runDeploy(
      wizard.credentials,
      target,
      release,
      (step, status, detail) => wizard.setStepStatus(step, status, detail),
      (step, fraction) => wizard.setStepProgress(step, fraction),
    );
    wizard.finishSuccess(result);
    await delay(1200);
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
          <!-- MinWidth/MinHeight default to 16 and clamp Width/Height, so both
               have to be set for the ring to match the dot it replaces. -->
          <FluentProgressRing v-if="entry.status === 'running'" :size="10" />
          <span v-else class="status-dot" :class="`status-dot-${entry.status}`" />
          {{ t(`execute.steps.${entry.step}`) }}
        </dt>
        <dd>
          <template v-if="entry.status === 'running' && entry.progress !== undefined">
            {{ Math.round(entry.progress * 100) }}%
          </template>
          <template v-else>{{ t(`execute.status.${entry.status}`) }}</template>
          <!-- Success details are bookkeeping ("Full rebuild not requested",
               the list of verified permissions); only a failure needs saying. -->
          <p v-if="entry.detail && entry.status === 'failed'" class="field-help" style="margin: 4px 0 0">{{ entry.detail }}</p>
          <!-- Only steps that transfer a known number of bytes get a bar; the
               rest are quick enough that the spinner alone reads better. -->
          <FluentProgressBar
            v-if="entry.status === 'running' && entry.progress !== undefined"
            :value="entry.progress * 100"
            style="margin-top: 6px"
          />
        </dd>
      </li>
    </ul>

    <div v-if="wizard.deployFailed" style="margin-top: 20px">
      <FluentNotice tone="danger">
        <strong>{{ t("execute.failedTitle") }}</strong>
        <p style="margin: 6px 0 0">{{ t("execute.failedAt", { step: t(`execute.steps.${failedStep}`) }) }}</p>
        <p style="margin: 6px 0 0">{{ failedMessage }}</p>
      </FluentNotice>
    </div>

    <Teleport defer to=".shell-card-actions">
      <div v-if="wizard.deployFailed && !running" class="step-actions">
        <div class="spacer" />
        <FluentButton tone="primary" @click="retry">{{ t("common.retry") }}</FluentButton>
      </div>
    </Teleport>
    <p v-if="wizard.deployFailed" class="field-help">{{ t("execute.retryFromHere") }}</p>
  </div>
</template>
