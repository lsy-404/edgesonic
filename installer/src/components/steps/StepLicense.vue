<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { fetchLicenseText } from "../../lib/github";
import { GITHUB_REPO } from "../../../../shared/autoupdate";
import officialLicense from "../../../../LICENSE?raw";

const { t } = useI18n();
const wizard = useWizard();

function normalizeRepo(repo: string): string {
  return repo.trim().replace(/\/+$/, "").toLowerCase();
}

const isOfficial = computed(() => !wizard.localPackage && normalizeRepo(wizard.sourceRepo) === normalizeRepo(GITHUB_REPO));
const officialLicenseUrl = computed(() => `https://github.com/${GITHUB_REPO}/blob/${wizard.selectedTag || "main"}/LICENSE`);
const thirdPartyRepoUrl = computed(() => `https://github.com/${wizard.sourceRepo.trim()}`);
const thirdPartyLicenseUrl = computed(() => `${thirdPartyRepoUrl.value}/blob/${wizard.selectedTag}/LICENSE`);

type SourceStatus = "official" | "local" | "checking" | "agpl" | "unclear" | "unavailable";
const status = ref<SourceStatus>("official");
const fetchedLicense = ref("");
let generation = 0;

async function loadLicense() {
  const current = ++generation;
  fetchedLicense.value = "";
  if (isOfficial.value) {
    status.value = "official";
    return;
  }
  if (wizard.localPackage) {
    status.value = "local";
    return;
  }
  status.value = "checking";
  try {
    const text = await fetchLicenseText(wizard.sourceRepo.trim(), wizard.selectedTag);
    if (current !== generation) return;
    fetchedLicense.value = text;
    status.value = /GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text) ? "agpl" : "unclear";
  } catch {
    if (current === generation) status.value = "unavailable";
  }
}

watch(() => [wizard.selectedTag, wizard.sourceRepo, wizard.localPackage] as const, loadLicense, { immediate: true });

// A third-party source shows its own LICENSE — that is the licence of the code
// being deployed. When it can't be read, fall back to the official text and say so.
const licenseText = computed(() => fetchedLicense.value || officialLicense);
const showingOfficialText = computed(() => !fetchedLicense.value);
const licenseUrl = computed(() => (isOfficial.value || wizard.localPackage ? officialLicenseUrl.value : thirdPartyLicenseUrl.value));

const alertClass = computed(() => (status.value === "official" || status.value === "agpl" ? "alert-info" : "alert-warning"));

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

    <div class="alert" :class="alertClass">
      <strong>{{ isOfficial ? t("license.sourceOfficialTitle") : t("license.sourceThirdPartyTitle") }}</strong>
      <p v-if="status === 'official'">{{ t("license.sourceOfficialBody") }}</p>
      <p v-else-if="status === 'local'">{{ t("license.sourceLocalBody") }}</p>
      <p v-else-if="status === 'checking'">{{ t("license.sourceChecking") }}</p>
      <p v-else-if="status === 'agpl'">{{ t("license.sourceAgpl") }}</p>
      <p v-else-if="status === 'unclear'">{{ t("license.sourceUnclear") }}</p>
      <p v-else>{{ t("license.sourceUnavailable") }}</p>
      <p v-if="!isOfficial && showingOfficialText && status !== 'checking'" class="field-help">
        {{ t("license.showingOfficialFallback") }}
      </p>
    </div>

    <div class="license-pane" role="region" :aria-label="t('license.title')" tabindex="0">
      <pre>{{ licenseText }}</pre>
    </div>

    <p class="field-help">
      <a :href="licenseUrl" target="_blank" rel="noreferrer">{{ t("license.viewOnGithub") }} ↗</a>
      ·
      <a href="https://www.gnu.org/licenses/agpl-3.0.txt" target="_blank" rel="noreferrer">{{ t("license.viewCanonical") }} ↗</a>
    </p>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>

<style scoped>
.license-pane {
  max-height: 460px;
  overflow: auto;
  margin-top: 16px;
  padding: 16px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.license-pane pre {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.55;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .license-pane {
    max-height: 320px;
    padding: 12px;
  }

  .license-pane pre {
    font-size: 0.72rem;
  }
}
</style>
