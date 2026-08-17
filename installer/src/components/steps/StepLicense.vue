<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { GITHUB_REPO } from "../../../../shared/autoupdate";
import officialLicense from "../../../../LICENSE?raw";
import { WinButton, WinInfoBar } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

// Releases only ever come from the official repository, so the bundled text is
// the licence of the code being deployed. A custom package is the one case the
// installer can't vouch for.
const licenseUrl = computed(() => `https://github.com/${GITHUB_REPO}/blob/${wizard.selectedTag || "main"}/LICENSE`);

function goNext() {
  wizard.step = 6;
}
function goBack() {
  wizard.step = 4;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("license.title") }}</h1>
    <p class="step-subtitle">{{ t("license.subtitle") }}</p>

    <WinInfoBar v-if="wizard.localPackage" Severity="Warning" :IsOpen="true" :IsClosable="false" :IsIconVisible="false">
      <strong>{{ t("license.sourceThirdPartyTitle") }}</strong>
      <p>{{ t("license.sourceLocalBody") }}</p>
    </WinInfoBar>

    <div class="license-pane" role="region" :aria-label="t('license.title')" tabindex="0">
      <pre>{{ officialLicense }}</pre>
    </div>

    <p class="field-help">
      <a :href="licenseUrl" target="_blank" rel="noreferrer">{{ t("license.viewOnGithub") }} ↗</a>
    </p>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <WinButton @Click="goBack">{{ t("common.back") }}</WinButton>
        <div class="spacer" />
        <WinButton Style="AccentButtonStyle" @Click="goNext">{{ t("common.next") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.license-pane {
  max-height: 260px;
  overflow: auto;
  margin-top: 16px;
  padding: 16px;
  background: var(--card-bg-secondary);
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-lg);
}

.license-pane pre {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.55;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .license-pane {
    max-height: 220px;
    padding: 12px;
  }

  .license-pane pre {
    font-size: 0.72rem;
  }
}
</style>
