<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { fetchReleases, fetchLicenseText } from "../../lib/github";
import { buildReleaseOptions, GITHUB_REPO, ZERO_VERSION } from "../../../../shared/autoupdate";
import { readLocalUpdatePackage } from "../../lib/deploy/manifest";

const { t } = useI18n();
const wizard = useWizard();

const loading = ref(false);
const errorMessage = ref("");
const localError = ref("");

function normalizeRepo(repo: string): string {
  return repo.trim().replace(/\/+$/, "").toLowerCase();
}

const isOfficial = computed(() => !wizard.localPackage && normalizeRepo(wizard.sourceRepo) === normalizeRepo(GITHUB_REPO));
const officialLicenseUrl = computed(() => `https://github.com/${GITHUB_REPO}/blob/${wizard.selectedTag || "main"}/LICENSE`);
const thirdPartyRepoUrl = computed(() => `https://github.com/${wizard.sourceRepo.trim()}`);
const thirdPartyLicenseUrl = computed(() => `${thirdPartyRepoUrl.value}/blob/${wizard.selectedTag}/LICENSE`);

type LicenseStatus = "idle" | "checking" | "agpl" | "unclear" | "unavailable";
const licenseStatus = ref<LicenseStatus>("idle");
let licenseGeneration = 0;

async function checkThirdPartyLicense() {
  if (isOfficial.value || wizard.localPackage || !wizard.sourceRepo.trim() || !wizard.selectedTag) {
    licenseStatus.value = "idle";
    return;
  }
  const generation = ++licenseGeneration;
  licenseStatus.value = "checking";
  try {
    const text = await fetchLicenseText(wizard.sourceRepo.trim(), wizard.selectedTag);
    if (generation !== licenseGeneration) return;
    licenseStatus.value = /GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text) ? "agpl" : "unclear";
  } catch {
    if (generation === licenseGeneration) licenseStatus.value = "unavailable";
  }
}

watch(() => [wizard.selectedTag, wizard.sourceRepo, wizard.localPackage] as const, checkThirdPartyLicense, { immediate: true });

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const releases = await fetchReleases(wizard.sourceRepo.trim());
    wizard.rawReleases = releases;
    const listing = buildReleaseOptions(releases, ZERO_VERSION);
    wizard.releases = listing.releases.filter((r) => r.hasArtifact).slice(0, 5);
    if (!wizard.selectedTag && listing.defaultTag) wizard.selectedTag = listing.defaultTag;
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const canContinue = computed(() => wizard.selectedTag.length > 0 && (!!wizard.localPackage || !!wizard.selectedRelease()));

async function selectLocalPackage(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  localError.value = "";
  try {
    wizard.selectLocalPackage(await readLocalUpdatePackage(file));
  } catch (error) {
    wizard.selectLocalPackage(null);
    localError.value = error instanceof Error ? error.message : String(error);
  }
}

function formatDate(value: string | null): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return "";
  }
}

function goNext() {
  wizard.step = 5;
}
function selectRelease(tag: string) {
  wizard.selectLocalPackage(null);
  wizard.selectedTag = tag;
}
function goBack() {
  wizard.step = 3;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("version.title") }}</h1>
    <p class="step-subtitle">{{ t("version.subtitle") }}</p>
    <p class="field-help">{{ t("version.freeNotice") }}</p>

    <div v-if="wizard.mode === 'overwrite'" class="alert alert-warning">
      <strong>{{ t("overwriteAdvice.title") }}</strong>
      <p>{{ t("overwriteAdvice.message") }}</p>
    </div>

    <div class="field">
      <label for="sourceRepo">{{ t("version.sourceRepo") }}</label>
      <input id="sourceRepo" v-model.trim="wizard.sourceRepo" type="text" spellcheck="false" @change="load" />
      <p class="field-help">{{ t("version.sourceRepoHelp") }}</p>
    </div>

    <p v-if="loading">{{ t("common.loading") }}</p>
    <div v-else-if="errorMessage" class="alert alert-danger">{{ errorMessage }}</div>
    <div v-else-if="wizard.releases.length === 0" class="alert alert-warning">{{ t("version.noneEligible") }}</div>

    <template v-else>
      <button
        v-for="release in wizard.releases"
        :key="release.tag"
        type="button"
        class="card-option"
        :class="{ selected: wizard.selectedTag === release.tag }"
        @click="selectRelease(release.tag)"
      >
        <h3>
          {{ release.name || release.tag }}
          <span v-if="release.tag === wizard.releases.find((r) => !r.prerelease)?.tag" class="field-tag recommended">{{ t("version.recommended") }}</span>
          <span v-if="release.prerelease" class="field-tag optional">{{ t("version.prerelease") }}</span>
        </h3>
        <p>{{ release.tag }} · {{ formatDate(release.publishedAt) }}</p>
      </button>
    </template>

    <div class="field" style="margin-top: 24px">
      <label for="localPackage">{{ t("version.localPackage") }}</label>
      <input id="localPackage" type="file" accept=".zip,application/zip" @change="selectLocalPackage" />
      <p class="field-help">{{ t("version.localPackageHelp") }}</p>
      <div v-if="wizard.localPackage" class="alert alert-warning">
        {{ t("version.localPackageWarning", { name: wizard.localPackage.fileName, version: wizard.localPackage.manifest.version }) }}
      </div>
      <div v-if="localError" class="alert alert-danger">{{ localError }}</div>
    </div>

    <div v-if="wizard.selectedTag" class="alert" :class="isOfficial ? 'alert-info' : 'alert-warning'" style="margin-top: 16px">
      <template v-if="isOfficial">
        <strong>{{ t("version.licenseOfficialTitle") }}</strong>
        <p>
          {{ t("version.licenseOfficialBody") }}
          <a :href="officialLicenseUrl" target="_blank" rel="noreferrer">{{ t("version.licenseViewLink") }} ↗</a>
        </p>
      </template>
      <template v-else-if="wizard.localPackage">
        <strong>{{ t("version.licenseThirdPartyTitle") }}</strong>
        <p>{{ t("version.licenseLocalWarning") }}</p>
      </template>
      <template v-else>
        <strong>{{ t("version.licenseThirdPartyTitle") }}</strong>
        <p v-if="licenseStatus === 'checking'">{{ t("version.licenseThirdPartyChecking") }}</p>
        <p v-else-if="licenseStatus === 'agpl'">
          {{ t("version.licenseThirdPartyFound") }}
          <a :href="thirdPartyLicenseUrl" target="_blank" rel="noreferrer">{{ t("version.licenseViewLink") }} ↗</a>
        </p>
        <p v-else-if="licenseStatus === 'unclear'">
          {{ t("version.licenseThirdPartyMismatch") }}
          <a :href="thirdPartyLicenseUrl" target="_blank" rel="noreferrer">{{ t("version.licenseViewLink") }} ↗</a>
        </p>
        <p v-else>
          {{ t("version.licenseThirdPartyUnavailable") }}
          <a :href="thirdPartyRepoUrl" target="_blank" rel="noreferrer">{{ t("version.licenseViewLink") }} ↗</a>
        </p>
      </template>
    </div>

    <button type="button" class="btn btn-secondary" style="margin-top: 8px" :disabled="loading" @click="load">{{ t("version.reload") }}</button>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!canContinue" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
