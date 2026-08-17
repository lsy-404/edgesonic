<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWizard } from "../../stores/wizard";
import { WinButton, WinInfoBar } from "../../vendor/winui";

const { t } = useI18n();
const wizard = useWizard();

const copiedField = ref("");

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

function startOver() {
  location.reload();
}
</script>

<template>
  <div>
    <h1 class="step-title">{{ t("done.title") }}</h1>

    <div class="kv-list">
      <div class="kv-row">
        <dt>{{ t("done.urlLabel") }}</dt>
        <dd>
          <a v-if="wizard.result?.url" :href="wizard.result.url" target="_blank" rel="noreferrer">{{ wizard.result.url }}</a>
          <a v-else :href="`https://dash.cloudflare.com/${wizard.result?.accountId}/workers/services/view/${wizard.workerName}/production`" target="_blank" rel="noreferrer">
            dash.cloudflare.com → {{ wizard.workerName }} → production
          </a>
        </dd>
      </div>
    </div>

    <WinInfoBar v-if="wizard.result?.adminPassword" :IsOpen="true" Severity="Success" :IsClosable="false" :IsIconVisible="false">
      <strong>{{ t("done.adminTitle") }}</strong>
      <div class="kv-list" style="margin-top: 10px; background: transparent">
        <div class="kv-row">
          <dt>{{ t("done.adminUsername") }}</dt>
          <dd>
            {{ wizard.result?.adminUsername }}
            <WinButton style="padding: 2px 10px; font-size: 0.75rem" @Click="copy(wizard.result?.adminUsername || '', 'user')">
              {{ copiedField === "user" ? t("common.copied") : t("common.copy") }}
            </WinButton>
          </dd>
        </div>
        <div class="kv-row">
          <dt>{{ t("done.adminPassword") }}</dt>
          <dd>
            <code>{{ wizard.result?.adminPassword }}</code>
            <WinButton style="padding: 2px 10px; font-size: 0.75rem" @Click="copy(wizard.result?.adminPassword || '', 'pass')">
              {{ copiedField === "pass" ? t("common.copied") : t("common.copy") }}
            </WinButton>
          </dd>
        </div>
      </div>
      <p style="margin: 10px 0 0">{{ t("done.saveWarning") }}</p>
    </WinInfoBar>

    <WinInfoBar :IsOpen="true" Severity="Informational" :IsClosable="false" :IsIconVisible="false">
      <strong>{{ t("done.nextStepsTitle") }}</strong>
      <p style="margin: 6px 0 0">{{ t("done.nextStepsDesc") }}</p>
      <a :href="`https://github.com/${wizard.sourceRepo}/blob/${wizard.selectedTag}/worker/SECRETS.md`" target="_blank" rel="noreferrer">{{ t("done.secretsLink") }}</a>
    </WinInfoBar>

    <div class="step-actions">
      <div class="spacer" />
      <WinButton Style="AccentButtonStyle" @Click="startOver">{{ t("done.startOver") }}</WinButton>
    </div>
  </div>
</template>
