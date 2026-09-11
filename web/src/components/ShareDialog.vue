<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";

const props = defineProps<{
  open: boolean;
  songIds: string[];
  label: string;
}>();

const emit = defineEmits<{
  close: [];
  created: [url: string];
}>();

const { t } = useI18n();
const { authFetch } = useAuth();
const description = ref("");
const expiresType = ref<"never" | "days" | "datetime">("never");
const expiresDays = ref(7);
const expiresAt = ref("");
const busy = ref(false);
const error = ref("");
const createdUrl = ref("");
const created = ref(false);
const copyMessage = ref("");
const uniqueSongIds = computed(() => Array.from(new Set(props.songIds.filter(Boolean))));

function reset() {
  description.value = "";
  expiresType.value = "never";
  expiresDays.value = 7;
  expiresAt.value = "";
  busy.value = false;
  error.value = "";
  createdUrl.value = "";
  created.value = false;
  copyMessage.value = "";
}

watch(() => props.open, (open) => {
  if (open) reset();
});

function extractError(xml: string): string | null {
  const match = /<error[^>]+message="([^"]+)"/.exec(xml);
  return match?.[1] || null;
}

function extractUrl(xml: string): string {
  const match = /<share\s+[^>]*\burl="([^"]+)"/.exec(xml);
  return match?.[1]?.replace(/&amp;/g, "&") || "";
}

function expiresMs(): number | undefined {
  if (expiresType.value === "never") return undefined;
  if (expiresType.value === "days") {
    const days = Number(expiresDays.value);
    return Number.isFinite(days) && days > 0 ? Date.now() + Math.floor(days * 86400000) : undefined;
  }
  if (!expiresAt.value) return undefined;
  const timestamp = Date.parse(expiresAt.value);
  return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp : undefined;
}

async function submit() {
  if (busy.value) return;
  if (!uniqueSongIds.value.length) {
    error.value = t("shares.targetSelectRequired");
    return;
  }
  if (expiresType.value !== "never" && expiresMs() === undefined) {
    error.value = t("shares.invalidExpires");
    return;
  }
  busy.value = true;
  error.value = "";
  copyMessage.value = "";
  try {
    const params: Record<string, string | string[]> = { id: uniqueSongIds.value };
    const note = description.value.trim();
    if (note) params.description = note;
    const expiry = expiresMs();
    if (expiry !== undefined) params.expires = String(expiry);
    const xml = await authFetch("createShare", params);
    if (/status=["']failed["']/.test(xml)) {
      error.value = extractError(xml) || t("shares.addFailed");
      return;
    }
    createdUrl.value = extractUrl(xml);
    created.value = true;
    emit("created", createdUrl.value);
  } catch {
    error.value = t("shares.addFailed");
  } finally {
    busy.value = false;
  }
}

async function copyUrl() {
  if (!createdUrl.value) return;
  try {
    await navigator.clipboard.writeText(createdUrl.value);
    copyMessage.value = t("shares.copied");
  } catch {
    copyMessage.value = t("shares.copyFailed");
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
      <section class="modal share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
        <div id="share-dialog-title" class="modal-title">{{ t("shares.create") }} — {{ label }}</div>
        <div v-if="!created" class="share-dialog-form">
          <div class="form-group">
            <label class="form-label">{{ t("shares.description") }} <span class="optional">({{ t("shares.optional") }})</span></label>
            <input v-model="description" class="form-input" :placeholder="t('shares.descriptionPlaceholder')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("shares.expires") }}</label>
            <div class="share-dialog-segments">
              <button type="button" :class="['seg-btn', { active: expiresType === 'never' }]" @click="expiresType = 'never'">{{ t("shares.expiresNever") }}</button>
              <button type="button" :class="['seg-btn', { active: expiresType === 'days' }]" @click="expiresType = 'days'">{{ t("shares.expiresIn") }}</button>
              <button type="button" :class="['seg-btn', { active: expiresType === 'datetime' }]" @click="expiresType = 'datetime'">{{ t("shares.expiresAt") }}</button>
            </div>
            <div v-if="expiresType === 'days'" class="share-dialog-days">
              <input v-model.number="expiresDays" type="number" min="1" max="3650" class="form-input" />
              <span class="mono-label">{{ t("shares.days") }}</span>
            </div>
            <input v-if="expiresType === 'datetime'" v-model="expiresAt" type="datetime-local" class="form-input share-dialog-date" />
          </div>
          <div v-if="error" class="status-badge error" role="alert">{{ error }}</div>
        </div>
        <div v-else class="share-dialog-created">
          <div class="mono-label">{{ t("shares.publicUrl") }}:</div>
          <div class="share-dialog-url">{{ createdUrl || t("shares.added") }}</div>
          <button v-if="createdUrl" class="btn-secondary btn-sm" @click="copyUrl">{{ t("shares.copyUrl") }}</button>
          <span v-if="copyMessage" class="mono-label" role="status">{{ copyMessage }}</span>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="emit('close')">{{ created ? t("common.close") : t("shares.cancel") }}</button>
          <button v-if="!created" class="btn-primary" :disabled="busy" @click="submit">{{ busy ? t("common.loading") : t("shares.save") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.share-dialog { max-width: 480px; }
.share-dialog-form { display: flex; flex-direction: column; gap: 0.7rem; }
.share-dialog-segments { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.share-dialog-days { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
.share-dialog-days .form-input { max-width: 100px; }
.share-dialog-date { margin-top: 0.5rem; }
.share-dialog-created { display: flex; flex-direction: column; gap: 0.45rem; }
.share-dialog-url { padding: 0.6rem 0.7rem; overflow-wrap: anywhere; background: var(--color-bg-primary); border: 1px solid var(--color-border-subtle); color: var(--color-text-primary); font-family: var(--font-mono); font-size: var(--fs-xs); }
</style>
