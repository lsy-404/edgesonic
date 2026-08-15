<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";

const { t } = useI18n();
const wizard = useWizard();

function choose(mode: "fresh" | "overwrite") {
  wizard.mode = mode;
  wizard.step = 2;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("welcome.title") }}</h1>
    <p class="step-subtitle">{{ t("welcome.subtitle") }}</p>

    <button type="button" class="card-option" :class="{ selected: wizard.mode === 'fresh' }" @click="choose('fresh')">
      <h3>{{ t("welcome.freshTitle") }}</h3>
      <p>{{ t("welcome.freshDesc") }}</p>
    </button>
    <button type="button" class="card-option" :class="{ selected: wizard.mode === 'overwrite' }" @click="choose('overwrite')">
      <h3>{{ t("welcome.overwriteTitle") }}</h3>
      <p>{{ t("welcome.overwriteDesc") }}</p>
    </button>

    <div class="alert alert-info" style="margin-top: 24px">
      <strong>{{ t("welcome.requirementsTitle") }}</strong>
      <ul style="margin: 8px 0 0; padding-left: 20px">
        <li>{{ t("welcome.requirement1") }}</li>
        <li>{{ t("welcome.requirement2") }}</li>
        <li>{{ t("welcome.requirement3") }}</li>
      </ul>
    </div>
  </div>
</template>
