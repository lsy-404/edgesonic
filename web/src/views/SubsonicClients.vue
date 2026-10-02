<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";
import Icon from "../components/Icon.vue";
import { FluentButton, FluentSelect } from "@platform-kit/fluent/vue";

const { t, locale } = useI18n();
const { hasPerm, isGuest, username, edgesonicFetch, edgesonicPost } = useAuth();
interface Credential { id: string; label: string; lastUsed: number; createdAt: number; streamProxyStrategy: string; }
const credentials = ref<Credential[]>([]);
const credLoading = ref(false);
const credError = ref("");
const credLabel = ref("");
const credBusy = ref(false);
const issued = ref<{ password: string; label: string } | null>(null);
const serverUrl = window.location.origin;
const canManageCredentials = computed(() => !isGuest.value && hasPerm("manage_credentials"));
const toast = ref({ show: false, msg: "", type: "success" });
const strategyOptions = [
  { value: "always", key: "settings.clients.strategyAlways" },
  { value: "never", key: "settings.clients.strategyNever" },
  { value: "r2_only", key: "settings.clients.strategyR2Only" },
  { value: "webdav_only", key: "settings.clients.strategyWebdavOnly" },
];
let componentActive = true;
let credentialLoadGeneration = 0;

function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

function formatTs(epochSec: number): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString(locale.value);
}

async function loadCredentials() {
  if (!canManageCredentials.value) return;
  const generation = ++credentialLoadGeneration;
  credLoading.value = true;
  credError.value = "";
  try {
    const xml = await edgesonicFetch("auth/credentials/list");
    if (!componentActive || !canManageCredentials.value || generation !== credentialLoadGeneration) return;
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    credentials.value = parseXmlAttrs(xml, "credential").map((r) => ({
      id: r.id || "",
      label: r.label || "",
      lastUsed: Number.parseInt(r.lastUsed || "0", 10),
      createdAt: Number.parseInt(r.createdAt || "0", 10),
      streamProxyStrategy: r.streamProxyStrategy || "always",
    }));
  } catch {
    if (!componentActive || !canManageCredentials.value || generation !== credentialLoadGeneration) return;
    credentials.value = [];
    credError.value = t("settings.clients.loadFailed");
  } finally {
    if (generation === credentialLoadGeneration) credLoading.value = false;
  }
}

function genPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint32Array(20);
  crypto.getRandomValues(buf);
  return Array.from(buf, (v) => chars[v % chars.length]).join("");
}

async function createCredential() {
  if (credBusy.value || !canManageCredentials.value) return;
  credBusy.value = true;
  const password = genPassword();
  const label = credLabel.value.trim();
  try {
    const xml = await edgesonicPost("auth/credentials/create", { password, label });
    if (!componentActive || !canManageCredentials.value) return;
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    issued.value = { password, label };
    credLabel.value = "";
    await loadCredentials();
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
  } finally {
    credBusy.value = false;
  }
}

async function updateCredentialLabel(cr: Credential, newLabel: string) {
  const trimmed = newLabel.trim();
  if (trimmed === cr.label) return;
  if (trimmed.length > 200) {
    showToast(t("settings.clients.labelTooLong"), "error");
    await loadCredentials();
    return;
  }
  try {
    const xml = await edgesonicPost("auth/credentials/update", { id: cr.id, label: trimmed });
    if (!componentActive || !canManageCredentials.value) return;
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    cr.label = trimmed;
    showToast(t("settings.clients.labelSaved"));
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
    await loadCredentials();
  }
}

async function deleteCredential(id: string) {
  if (!confirm(t("settings.clients.revokeConfirm")) || !canManageCredentials.value) return;
  try {
    const xml = await edgesonicPost("auth/credentials/delete", { id });
    if (!componentActive || !canManageCredentials.value) return;
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    issued.value = null;
    await loadCredentials();
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
  }
}

async function updateCredentialStrategy(cr: Credential, newStrategy: string) {
  if (newStrategy === cr.streamProxyStrategy) return;
  try {
    const xml = await edgesonicPost("auth/credentials/update", { id: cr.id, label: cr.label, streamProxyStrategy: newStrategy });
    if (!componentActive || !canManageCredentials.value) return;
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    cr.streamProxyStrategy = newStrategy;
    showToast(t("settings.clients.strategySaved"));
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
    await loadCredentials();
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t("common.copied"));
  } catch {
    showToast(t("settings.common.copyFailed"), "error");
  }
}

watch(canManageCredentials, (allowed) => {
  if (allowed) {
    void loadCredentials();
    return;
  }
  credentialLoadGeneration++;
  credLoading.value = false;
  credentials.value = [];
  issued.value = null;
  credLabel.value = "";
}, { immediate: true });
onBeforeUnmount(() => {
  componentActive = false;
  credentialLoadGeneration++;
  issued.value = null;
});
</script>

<template>
  <div class="clients-page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("settings.label") }}</div>
        <h1 class="page-title">{{ t("settings.clients.title") }}</h1>
      </div>
    </div>

    <template v-if="canManageCredentials">
      <section class="clients-card card">
        <header class="clients-card-header">
          <div>
            <h2 class="section-title">{{ t("settings.clients.connectTitle") }}</h2>
            <p class="feature-desc">{{ t("settings.clients.desc") }}</p>
          </div>
        </header>

        <ol class="setup-steps">
          <li>{{ t("settings.clients.setupServer") }}</li>
          <li>{{ t("settings.clients.setupUsername", { username }) }}</li>
          <li>{{ t("settings.clients.setupPassword") }}</li>
          <li>{{ t("settings.clients.setupConnect") }}</li>
        </ol>

        <div class="connection-details-grid">
          <div class="connection-detail">
            <span class="mono-label">{{ t("settings.clients.server") }}</span>
            <code class="issued-value">{{ serverUrl }}</code>
            <FluentButton type="button" tone="secondary" class="btn-secondary btn-sm" @click="copyText(serverUrl)">{{ t("common.copy") }}</FluentButton>
          </div>
          <div class="connection-detail">
            <span class="mono-label">{{ t("settings.clients.username") }}</span>
            <code class="issued-value">{{ username }}</code>
            <FluentButton type="button" tone="secondary" class="btn-secondary btn-sm" @click="copyText(username)">{{ t("common.copy") }}</FluentButton>
          </div>
        </div>

        <form class="cred-create" @submit.prevent="createCredential">
          <label class="cred-label-field">
            <span class="mono-label">{{ t("settings.clients.labelPlaceholder") }}</span>
            <input v-model="credLabel" class="form-input" maxlength="200" autocomplete="off" />
          </label>
          <FluentButton type="submit" tone="primary" class="btn-primary" :disabled="credBusy">{{ t("settings.clients.create") }}</FluentButton>
        </form>

        <div v-if="issued" class="issued-panel" role="status" aria-live="polite">
          <div class="issued-title">{{ t("settings.clients.createdTitle") }}</div>
          <p class="feature-desc">{{ t("settings.clients.oneTimeHint") }}</p>
          <div class="issued-row issued-password-row">
            <span class="mono-label">{{ t("settings.clients.password") }}</span>
            <code class="issued-value">{{ issued.password }}</code>
            <FluentButton type="button" tone="secondary" class="btn-secondary btn-sm" @click="copyText(issued.password)">{{ t("common.copy") }}</FluentButton>
          </div>
        </div>
      </section>

      <section class="clients-card card">
        <header class="clients-card-header">
          <div>
            <h2 class="section-title">{{ t("settings.clients.credentialsTitle") }}</h2>
            <p class="feature-desc">{{ t("settings.clients.credentialsDesc") }}</p>
          </div>
        </header>

        <div v-if="credLoading" class="empty-state">{{ t("common.loading") }}</div>
        <div v-else-if="credError" class="error-panel">
          <span class="status-badge error">{{ t("settings.common.apiError") }}</span>
          <p class="error-text">{{ credError }}</p>
          <FluentButton type="button" tone="secondary" class="btn-secondary btn-sm" :disabled="credLoading" @click="loadCredentials">{{ t("common.retry") }}</FluentButton>
        </div>
        <div v-else-if="!credentials.length" class="empty-state">
          <div class="empty-state-icon"><Icon name="empty" /></div>
          <div>{{ t("settings.clients.empty") }}</div>
        </div>
        <div v-else class="credential-list">
          <article v-for="cr in credentials" :key="cr.id" class="credential-card">
            <div class="credential-main">
              <span class="mono-label">{{ t("settings.clients.colLabel") }}</span>
              <input
                class="form-input cred-label-edit"
                :value="cr.label"
                :placeholder="t('settings.clients.labelEditPlaceholder')"
                maxlength="200"
                :aria-label="t('settings.clients.labelEditPlaceholder')"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
                @keydown.esc="loadCredentials()"
                @blur="updateCredentialLabel(cr, ($event.target as HTMLInputElement).value)"
              />
              <code class="session-id" :title="cr.id">{{ cr.id }}</code>
            </div>
            <div class="credential-detail">
              <span><span class="mono-label">{{ t("settings.clients.colCreated") }}</span><span>{{ formatTs(cr.createdAt) }}</span></span>
              <span><span class="mono-label">{{ t("settings.clients.colLastUsed") }}</span><span>{{ cr.lastUsed ? formatTs(cr.lastUsed) : t("settings.clients.never") }}</span></span>
              <label class="credential-strategy">
                <span class="mono-label">{{ t("settings.clients.colStrategy") }}</span>
                <FluentSelect
                  class="form-input cred-strategy-select"
                  :model-value="cr.streamProxyStrategy"
                  :aria-label="t('settings.clients.colStrategy')"
                  :options="strategyOptions.map(opt => ({ value: opt.value, label: t(opt.key) }))"
                  @update:model-value="updateCredentialStrategy(cr, $event)"
                />
              </label>
              <FluentButton type="button" tone="danger" class="btn-danger btn-sm credential-revoke" @click="deleteCredential(cr.id)">{{ t("settings.clients.revoke") }}</FluentButton>
            </div>
          </article>
        </div>
      </section>
    </template>
    <section v-else class="clients-card card empty-state">
      <div class="empty-state-icon"><Icon name="lock" /></div>
      <div>{{ t("settings.clients.permissionRequired") }}</div>
    </section>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.clients-page { max-width: 1120px; margin: 0 auto; padding-bottom: 2rem; }
.clients-card { padding: 1.2rem; margin: 0 0 1rem; }
.clients-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.clients-card-header .feature-desc { margin: 0.45rem 0 0; max-width: 70ch; }
.setup-steps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem 1.5rem; margin: 0 0 1.2rem; padding-left: 1.7rem; color: var(--color-text-secondary); line-height: 1.5; }
.setup-steps li { padding-left: 0.25rem; }
.connection-details-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; margin: 0 0 1.1rem; }
.connection-detail { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.45rem 0.6rem; padding: 0.7rem; border: 1px solid var(--color-border-subtle); background: var(--color-bg-primary); min-width: 0; }
.connection-detail .mono-label { grid-column: 1 / -1; }
.cred-create { display: flex; align-items: flex-end; gap: 0.75rem; }
.cred-label-field { flex: 1; display: grid; gap: 0.45rem; min-width: 0; }
.issued-panel { border: 1px solid var(--color-accent-primary); background: var(--color-bg-primary); padding: 1rem; margin-top: 1.1rem; }
.issued-title { color: var(--color-accent-primary); font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
.issued-panel > .feature-desc { margin: 0.45rem 0 0.8rem; }
.issued-row { display: grid; grid-template-columns: 6rem minmax(0, 1fr) auto; align-items: center; gap: 0.6rem; }
.issued-value { min-width: 0; overflow-wrap: anywhere; font-family: var(--font-mono); color: var(--color-text-primary); background: var(--color-bg-tertiary); border: 1px solid var(--color-border-subtle); padding: 0.35rem 0.55rem; user-select: all; }
.credential-list { display: grid; gap: 0.7rem; }
.credential-card { display: grid; grid-template-columns: minmax(12rem, 0.8fr) minmax(0, 2fr); gap: 1rem; padding: 0.85rem; border: 1px solid var(--color-border-subtle); background: var(--color-bg-primary); min-width: 0; }
.credential-main { display: grid; gap: 0.35rem; align-content: start; min-width: 0; }
.credential-detail { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem 1rem; align-items: end; }
.credential-detail > span, .credential-strategy { display: grid; gap: 0.35rem; min-width: 0; color: var(--color-text-secondary); font-size: var(--fs-sm); }
.credential-detail .mono-label, .credential-main .mono-label { color: var(--color-text-muted); }
.session-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); }
.cred-label-edit { width: 100%; padding: 0.35rem 0.5rem; }
.cred-strategy-select { width: 100%; min-height: 2.25rem; }
.credential-revoke { justify-self: end; }
.error-panel { display: flex; flex-direction: column; align-items: flex-start; gap: 0.6rem; }
.error-text { color: var(--color-text-secondary); }
.toast { position: fixed; right: 1.5rem; bottom: 5.5rem; z-index: 60; padding: 0.65rem 1rem; background: var(--color-bg-secondary); border: 1px solid var(--color-accent-primary); color: var(--color-text-primary); font-size: var(--fs-sm); }
.toast-error { border-color: #e5484d; }

@media (max-width: 760px) {
  .clients-card { padding: 0.9rem; }
  .setup-steps { grid-template-columns: 1fr; }
  .connection-details-grid { grid-template-columns: 1fr; }
  .credential-card { grid-template-columns: 1fr; }
  .credential-detail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 480px) {
  .cred-create { align-items: stretch; flex-direction: column; }
  .issued-row { grid-template-columns: 1fr auto; }
  .issued-row .mono-label { grid-column: 1 / -1; }
  .credential-detail { grid-template-columns: 1fr; }
  .clients-card-header { flex-direction: column; }
}
</style>
