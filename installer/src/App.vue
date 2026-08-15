<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useWizard } from "./stores/wizard";
import WizardShell from "./components/WizardShell.vue";
import StepWelcome from "./components/steps/StepWelcome.vue";
import StepCredentials from "./components/steps/StepCredentials.vue";
import StepTarget from "./components/steps/StepTarget.vue";
import StepVersion from "./components/steps/StepVersion.vue";
import StepReview from "./components/steps/StepReview.vue";
import StepExecute from "./components/steps/StepExecute.vue";
import StepDone from "./components/steps/StepDone.vue";

const wizard = useWizard();
const TOTAL_STEPS = 7;

const current = computed(() => {
  switch (wizard.step) {
    case 1:
      return StepWelcome;
    case 2:
      return StepCredentials;
    case 3:
      return StepTarget;
    case 4:
      return StepVersion;
    case 5:
      return StepReview;
    case 6:
      return StepExecute;
    default:
      return StepDone;
  }
});
</script>

<template>
  <WizardShell :step="Math.min(wizard.step, TOTAL_STEPS)" :total="TOTAL_STEPS">
    <component :is="current" />
  </WizardShell>
</template>
