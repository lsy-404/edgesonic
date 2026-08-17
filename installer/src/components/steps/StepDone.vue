<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { GITHUB_REPO } from "../../../../shared/autoupdate";
import { WinButton, WinCheckBox, WinInfoBar } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

const copiedField = ref("");

interface ConfettiPiece {
  id: number;
  style: Record<string, string>;
}
const confettiPieces = ref<ConfettiPiece[]>([]);

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#0067C0", "#4CC2FF", "#FFB900", "#E74856", "#00CC6A", "#B146C2"];
  confettiPieces.value = Array.from({ length: 70 }, (_, i) => ({
    id: i,
    style: {
      left: `${Math.random() * 100}%`,
      background: colors[i % colors.length],
      animationDelay: `${Math.random() * 0.5}s`,
      animationDuration: `${2.2 + Math.random() * 1.4}s`,
      "--confetti-drift": `${(Math.random() - 0.5) * 140}px`,
      "--confetti-spin": `${Math.random() > 0.5 ? "" : "-"}${540 + Math.random() * 360}deg`,
    },
  }));
  setTimeout(() => {
    confettiPieces.value = [];
  }, 4000);
});

const instanceUrl = computed(
  () => wizard.result?.url || `https://dash.cloudflare.com/${wizard.result?.accountId}/workers/services/view/${wizard.workerName}/production`,
);

async function copy(text: string, field: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedField.value = field;
    setTimeout(() => {
      if (copiedField.value === field) copiedField.value = "";
    }, 1500);
  } catch {
    // Clipboard API unavailable (insecure context, permission denied) — the
    // value is still selectable/visible on screen, so this is a soft failure.
  }
}

function openInstance() {
  window.open(instanceUrl.value, "_blank", "noreferrer");
}

function downloadInfo() {
  const lines = [
    `${t("done.urlLabel")}: ${instanceUrl.value}`,
    `${t("done.adminUsername")}: ${wizard.result?.adminUsername || ""}`,
    `${t("done.adminPassword")}: ${wizard.result?.adminPassword || ""}`,
  ];
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `edgesonic-${(wizard.result?.accountId || "").slice(0, 8) || "instance"}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const clearCredentials = ref(true);

function finish() {
  if (clearCredentials.value) wizard.clearCredentials(true);
  location.reload();
}
</script>

<template>
  <div>
    <Teleport to="body">
      <div class="confetti-layer" aria-hidden="true">
        <span v-for="piece in confettiPieces" :key="piece.id" class="confetti-piece" :style="piece.style" />
      </div>
    </Teleport>

    <h1 class="step-title">{{ t("done.title") }}</h1>

    <p class="field-help">{{ t("done.urlLabel") }}</p>
    <p style="margin: 4px 0 16px; word-break: break-all">{{ instanceUrl }}</p>
    <WinButton Style="AccentButtonStyle" style="width: 100%" @Click="openInstance">
      {{ t("done.openLink") }} ↗
    </WinButton>

    <WinInfoBar :IsOpen="true" Severity="Informational" :IsClosable="false" :IsIconVisible="false" style="margin-top: 16px">
      {{ t("done.propagationNotice") }}
    </WinInfoBar>

    <section v-if="wizard.result?.adminPassword" class="guide-card credential-card">
      <h3>{{ t("done.adminTitle") }}</h3>
      <div class="credential-row">
        <span class="credential-label">{{ t("done.adminUsername") }}</span>
        <span class="credential-value">{{ wizard.result?.adminUsername }}</span>
        <WinButton style="padding: 2px 10px; font-size: 0.75rem" @Click="copy(wizard.result?.adminUsername || '', 'user')">
          {{ copiedField === "user" ? t("common.copied") : t("common.copy") }}
        </WinButton>
      </div>
      <div class="credential-row">
        <span class="credential-label">{{ t("done.adminPassword") }}</span>
        <code class="credential-value">{{ wizard.result?.adminPassword }}</code>
        <WinButton style="padding: 2px 10px; font-size: 0.75rem" @Click="copy(wizard.result?.adminPassword || '', 'pass')">
          {{ copiedField === "pass" ? t("common.copied") : t("common.copy") }}
        </WinButton>
      </div>
      <p style="margin: 10px 0 0">{{ t("done.saveWarning") }}</p>
      <WinButton style="margin-top: 10px" @Click="downloadInfo">{{ t("done.downloadInfo") }}</WinButton>
    </section>

    <WinInfoBar :IsOpen="true" Severity="Informational" :IsClosable="false" :IsIconVisible="false" style="margin-top: 16px">
      <strong>{{ t("done.nextStepsTitle") }}</strong>
      <p style="margin: 6px 0 0">{{ t("done.nextStepsDesc") }}</p>
      <a :href="`https://github.com/${GITHUB_REPO}/blob/${wizard.selectedTag}/worker/SECRETS.md`" target="_blank" rel="noreferrer">{{ t("done.secretsLink") }}</a>
    </WinInfoBar>

    <Teleport defer to=".shell-card-actions">
      <div class="step-actions">
        <div class="spacer" />
        <WinCheckBox v-model="clearCredentials" class="clear-credentials-check">
          <span>{{ t("done.clearCredentials") }}</span>
        </WinCheckBox>
        <WinButton Style="AccentButtonStyle" @Click="finish">{{ t("done.finish") }}</WinButton>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.credential-card {
  margin-top: 20px;
}

/* The global rule stacks checkboxes in a column; this one sits inline in the
   action bar next to the finish button. */
.clear-credentials-check {
  margin-bottom: 0;
  margin-right: 8px;
}
</style>
