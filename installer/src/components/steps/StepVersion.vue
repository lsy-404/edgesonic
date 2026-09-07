<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { fetchReleases } from "../../lib/github";
import { buildReleaseOptions, ZERO_VERSION } from "../../../../shared/autoupdate";
import { FluentButton, FluentNotice, FluentProgressRing } from "@lsypkg/fluent/vue";

const { t } = useI18n();
const wizard = useWizard();

const loading = ref(false);
const errorMessage = ref("");

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const releases = await fetchReleases();
    wizard.rawReleases = releases;
    const listing = buildReleaseOptions(releases, ZERO_VERSION);
    wizard.releases = listing.releases.filter((r) => r.hasArtifact).slice(0, 5);
    if (!wizard.releases.some((r) => r.tag === wizard.selectedTag)) {
      wizard.selectedTag = listing.defaultTag || "";
    }
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const canContinue = computed(() => wizard.selectedTag.length > 0 && !!wizard.selectedRelease());

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

    <div v-if="loading" class="version-loading">
      <FluentProgressRing :size="20" />
      <span>{{ t("common.loading") }}</span>
    </div>
    <FluentNotice v-else-if="errorMessage" tone="danger">{{ errorMessage }}</FluentNotice>
    <FluentNotice v-else-if="wizard.releases.length === 0" tone="warning">{{ t("version.noneEligible") }}</FluentNotice>

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

    <FluentButton style="margin-top: 8px" :disabled="loading" @click="load">{{ t("version.reload") }}</FluentButton>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <FluentButton @click="goBack">{{ t("common.back") }}</FluentButton>
        <div class="spacer" />
        <FluentButton tone="primary" :disabled="!canContinue" @click="goNext">{{ t("common.next") }}</FluentButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.version-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-secondary);
  margin-bottom: 1em;
}
</style>
