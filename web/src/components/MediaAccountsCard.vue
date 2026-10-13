<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import QRCode from "qrcode";

const { t } = useI18n();
const available = ref(false);
const busy = ref(false);
const error = ref("");
const accounts = ref<Array<{ provider: "youtube" | "bilibili"; connected: boolean; needsAuthorization?: boolean }>>([]);
const qr = ref("");
const qrStatus = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let alive = true;
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/edgesonic/media/accounts${path}`, { credentials: "same-origin", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t("mediaAccounts.failed"));
  return data;
}
async function load() {
  const data = await request<{ available: boolean; accounts: typeof accounts.value }>("");
  if (!alive) return;
  available.value = data.available;
  accounts.value = data.accounts;
}
async function importCookies(event: Event, provider: "youtube" | "bilibili") {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  busy.value = true; error.value = "";
  try {
    if (file.size > 65_536) throw new Error(t("mediaAccounts.fileTooLarge"));
    await request(`/${provider}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cookies: await file.text() }) });
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t("mediaAccounts.failed"); }
  finally { busy.value = false; input.value = ""; }
}
async function disconnect(provider: string) {
  if (provider === "bilibili") cancelQr();
  busy.value = true; error.value = "";
  try { await request(`/${provider}`, { method: "DELETE" }); await load(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t("mediaAccounts.failed"); }
  finally { busy.value = false; }
}
function cancelQr() { generation++; if (timer) clearTimeout(timer); qr.value = ""; qrStatus.value = ""; }
async function startQr() {
  cancelQr();
  const current = generation;
  busy.value = true; error.value = "";
  try {
    const data = await request<{ id: string; url: string; expiresAt: number }>("/bilibili/qr", { method: "POST" });
    if (!alive || generation !== current) return;
    qr.value = await QRCode.toDataURL(data.url, { width: 200, margin: 2 });
    qrStatus.value = "waiting";
    async function poll() {
      if (!alive || generation !== current) return;
      try {
        if (Date.now() / 1000 >= data.expiresAt) { qrStatus.value = "expired"; return; }
        const result = await request<{ status: string }>(`/bilibili/qr/${data.id}`);
        if (!alive || generation !== current) return;
        qrStatus.value = result.status;
        if (result.status === "authorized") { qr.value = ""; await load(); return; }
        if (result.status !== "expired") timer = setTimeout(() => void poll(), 2500);
      } catch (cause) { error.value = cause instanceof Error ? cause.message : t("mediaAccounts.failed"); }
    }
    timer = setTimeout(() => void poll(), 2500);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t("mediaAccounts.failed"); }
  finally { busy.value = false; }
}
onMounted(() => { void load().catch((cause) => { error.value = cause instanceof Error ? cause.message : t("mediaAccounts.failed"); }); });
onBeforeUnmount(() => { alive = false; cancelQr(); });
</script>
<template>
  <section v-if="available || error" class="card media-accounts">
    <h2>{{ t("mediaAccounts.title") }}</h2>
    <p class="feature-desc">{{ t("mediaAccounts.hint") }}</p>
    <p v-if="!available" class="feature-desc">{{ t("mediaAccounts.unavailable") }}</p>
    <div v-for="account in accounts" :key="account.provider" class="account-row">
      <div><strong>{{ account.provider === "youtube" ? "YouTube" : "Bilibili" }}</strong><p class="feature-desc">{{ account.connected ? t('mediaAccounts.saved') : account.needsAuthorization ? t('mediaAccounts.expired') : t('mediaAccounts.anonymous') }}</p></div>
      <button v-if="account.provider === 'bilibili'" class="btn-secondary btn-sm" :disabled="busy || !available" @click="startQr">{{ t("mediaAccounts.scan") }}</button>
      <label class="btn-secondary btn-sm cookie-import" :class="{ disabled: busy || !available }">{{ t("mediaAccounts.import") }}<input type="file" accept=".txt,text/plain" :disabled="busy || !available" @change="importCookies($event, account.provider)" /></label>
      <button v-if="account.connected || account.needsAuthorization" class="btn-secondary btn-sm" :disabled="busy" @click="disconnect(account.provider)">{{ t("mediaAccounts.disconnect") }}</button>
    </div>
    <p class="feature-desc">{{ t("mediaAccounts.cookieHint") }}</p>
    <div v-if="qr || qrStatus" class="account-qr"><img v-if="qr" :src="qr" :alt="t('mediaAccounts.scan')" /><p>{{ t(`mediaAccounts.${qrStatus}`) }}</p><button class="btn-secondary btn-sm" @click="cancelQr">{{ t("common.close") }}</button></div>
    <p v-if="error" role="alert" class="error-text">{{ error }}</p>
  </section>
</template>
<style scoped>
.media-accounts { padding: 1rem; }
h2 { margin: 0 0 .5rem; font-size: 1rem; }
.account-row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; padding: .8rem 0; border-top: 1px solid var(--color-border-subtle); }
.account-row > div { flex: 1; min-width: 160px; }
.account-row p { margin: .2rem 0 0; }
.cookie-import { position: relative; cursor: pointer; overflow: hidden; }
.cookie-import input { position: absolute; inset: 0; opacity: 0; width: 100%; cursor: pointer; }
.disabled { opacity: .5; }
.account-qr { display: grid; gap: .5rem; justify-items: start; }
.account-qr img { width: 200px; height: 200px; }
.error-text { color: var(--color-danger, #d13438); }
</style>
