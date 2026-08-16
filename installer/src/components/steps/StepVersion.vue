<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { fetchReleases } from "../../lib/github";
import { buildReleaseOptions, ZERO_VERSION } from "../../../../shared/autoupdate";

const { t } = useI18n();
const wizard = useWizard();

const loading = ref(false);
const errorMessage = ref("");

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

const canContinue = computed(() => wizard.selectedTag.length > 0);

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
function goBack() {
  wizard.step = 3;
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("version.title") }}</h1>
    <p class="step-subtitle">{{ t("version.subtitle") }}</p>

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
        @click="wizard.selectedTag = release.tag"
      >
        <h3>
          {{ release.name || release.tag }}
          <span v-if="release.tag === wizard.releases.find((r) => !r.prerelease)?.tag" class="field-tag recommended">{{ t("version.recommended") }}</span>
          <span v-if="release.prerelease" class="field-tag optional">{{ t("version.prerelease") }}</span>
        </h3>
        <p>{{ release.tag }} · {{ formatDate(release.publishedAt) }}</p>
      </button>
    </template>

    <button type="button" class="btn btn-secondary" style="margin-top: 8px" :disabled="loading" @click="load">{{ t("version.reload") }}</button>

    <div class="step-actions">
      <button type="button" class="btn btn-secondary" @click="goBack">{{ t("common.back") }}</button>
      <div class="spacer" />
      <button type="button" class="btn btn-primary" :disabled="!canContinue" @click="goNext">{{ t("common.next") }}</button>
    </div>
  </div>
</template>
