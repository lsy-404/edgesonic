
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import { activationDisplay, mapActivationError } from "../lib/activation";
import Icon from "../components/Icon.vue";

const { t, locale } = useI18n();
const router = useRouter();
const { activation, fetchActivationStatus, redeemActivationCode, fetchMe, logout } = useAuth();

const loading = ref(true);
const code = ref("");
const busy = ref(false);
const error = ref("");
const redeemed = ref(false);

const display = computed(() => activationDisplay(activation.value.status, activation.value.until));
const untilText = computed(() => activation.value.until
  ? new Date(activation.value.until * 1000).toLocaleString(locale.value)
  : "");

const badgeClass = computed(() => ({
  permanent: "success", until: "info", expired: "error", disabled: "error",
}[display.value]));

const statusText = computed(() => {
  if (display.value === "until") return t("activation.state.until", { date: untilText.value });
  return t(`activation.state.${display.value}`);
});

onMounted(async () => {
  await fetchActivationStatus();
  loading.value = false;
  // Already active (e.g. an admin renewed the account, or activation was
  // switched off) — nothing to do here.
  if (activation.value.active) void router.replace("/");
});

async function redeem() {
  if (busy.value || !code.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await redeemActivationCode(code.value.trim());
    if (!result.ok) {
      const key = result.error ? mapActivationError(result.error) : null;
      error.value = key ? t(key) : (result.error || t("activation.redeemFailed"));
      return;
    }
    redeemed.value = true;
    code.value = "";
    // Session-derived caps (permissions, level) may have changed with the
    // activation state; refresh before leaving.
    await fetchMe();
    if (activation.value.active) setTimeout(() => { void router.replace("/"); }, 900);
  } finally {
    busy.value = false;
  }
}

async function doLogout() {
  await logout();
  void router.replace("/login");
}
</script>

<template>
  <div class="page activation-page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("activation.label") }}</div>
        <h1 class="page-title">{{ t("activation.title") }}</h1>
      </div>
    </div>

    <div class="card activation-card">
      <div class="card-header"><span class="card-title">{{ t("activation.statusTitle") }}</span></div>

      <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>
      <template v-else>
        <div class="activation-status-row">
          <span :class="['status-badge', badgeClass]">{{ statusText }}</span>
        </div>
        <p class="activation-hint">{{ t("activation.requiredHint") }}</p>

        <div v-if="redeemed" class="activation-success">
          <Icon name="check" /> {{ t("activation.redeemSuccess") }}
        </div>

        <form class="activation-form" @submit.prevent="redeem">
          <div v-if="error" class="activation-error" role="alert">{{ error }}</div>
          <div class="form-group">
            <label class="form-label">{{ t("activation.codeLabel") }}</label>
            <input
              v-model="code"
              class="form-input activation-code-input"
              maxlength="64"
              :placeholder="t('activation.codePlaceholder')"
              :disabled="busy"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <div class="activation-actions">
            <button type="submit" class="btn-primary" :disabled="busy || !code.trim()">
              {{ busy ? t("activation.redeeming") : t("activation.redeem") }}
            </button>
            <button type="button" class="btn-secondary" @click="doLogout">{{ t("app.logout") }}</button>
          </div>
        </form>
      </template>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>
  </div>
</template>

<style scoped>
.activation-card { max-width: 480px; position: relative; }
.activation-status-row { margin: 0.75rem 0 0.5rem; }
.activation-hint { color: var(--color-text-secondary); font-size: var(--fs-sm); margin: 0 0 1rem; }
.activation-form { display: flex; flex-direction: column; gap: 0.9rem; }
.activation-code-input { font-family: var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
.activation-actions { display: flex; gap: 0.5rem; }
.activation-error {
  border: 1px solid var(--color-status-error);
  box-shadow: inset 3px 0 var(--color-status-error);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  padding: 0.6rem 0.8rem;
}
.activation-success {
  display: flex; align-items: center; gap: 0.5rem;
  color: var(--color-status-success, #4caf50);
  font-family: var(--font-mono); font-size: var(--fs-sm);
  margin-bottom: 0.75rem;
}
</style>
