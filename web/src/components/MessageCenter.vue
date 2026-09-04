<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { type MessageKind, type MessagePresentation, type UserMessage, useAuth } from "../api";
import Icon from "./Icon.vue";

const props = defineProps<{ isSuperAdmin: boolean; canManageUsers: boolean }>();
const { t } = useI18n();
const { getMessages, markMessageRead, dismissMessage, sendUserMessage } = useAuth();

const messages = ref<UserMessage[]>([]);
const officialMessages = ref<UserMessage[]>([]);
const panelOpen = ref(false);
const activeView = ref<"inbox" | "compose">("inbox");
const loading = ref(false);
const error = ref("");
const composeBusy = ref(false);
const compose = ref({ username: "", title: "", message: "", kind: "info" as MessageKind, presentation: "inbox" as MessagePresentation });
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function timestamp(message: UserMessage): number {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : 0;
}

const visibleOfficialMessages = computed(() => props.isSuperAdmin ? officialMessages.value : []);
const visibleMessages = computed(() => [...messages.value, ...visibleOfficialMessages.value]
  .sort((a, b) => timestamp(b) - timestamp(a)));
const unreadCount = computed(() => visibleMessages.value.filter((message) => !message.readAt).length);
const modalMessage = computed(() => visibleMessages.value.find((message) =>
  !message.readAt && message.presentation === "modal"));

function messageKind(message: UserMessage): "info" | "notice" | "warning" | "error" {
  return ["info", "notice", "warning", "error"].includes(message.kind) ? message.kind as "info" | "notice" | "warning" | "error" : "info";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function refresh() {
  loading.value = true;
  try {
    const feed = await getMessages();
    messages.value = feed.messages;
    officialMessages.value = props.isSuperAdmin ? feed.officialMessages : [];
    error.value = "";
  } catch {
    error.value = t("messages.loadFailed");
  } finally {
    loading.value = false;
  }
}

async function openCenter() {
  activeView.value = "inbox";
  panelOpen.value = true;
  void refresh();
  await nextTick();
  panel.value?.focus();
}

function closeCenter() {
  panelOpen.value = false;
  activeView.value = "inbox";
  void nextTick(() => trigger.value?.focus());
}

function openComposer() {
  activeView.value = "compose";
  error.value = "";
}

async function read(message: UserMessage) {
  if (message.readAt) return;
  try {
    await markMessageRead(message.id);
    message.readAt = new Date().toISOString();
  } catch {
    error.value = t("messages.actionFailed");
  }
}

async function dismiss(message: UserMessage) {
  try {
    await dismissMessage(message.id);
    messages.value = messages.value.filter((candidate) => candidate.id !== message.id);
    officialMessages.value = officialMessages.value.filter((candidate) => candidate.id !== message.id);
  } catch {
    error.value = t("messages.actionFailed");
  }
}

async function acknowledgeModal() {
  if (modalMessage.value) await read(modalMessage.value);
}

async function send() {
  if (!compose.value.username.trim() || !compose.value.title.trim() || !compose.value.message.trim()) return;
  composeBusy.value = true;
  try {
    await sendUserMessage({
      username: compose.value.username.trim(), title: compose.value.title.trim(), message: compose.value.message.trim(),
      kind: compose.value.kind, presentation: compose.value.presentation,
    });
    compose.value = { username: "", title: "", message: "", kind: "info", presentation: "inbox" };
    activeView.value = "inbox";
    await refresh();
  } catch {
    error.value = t("messages.sendFailed");
  } finally {
    composeBusy.value = false;
  }
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") void refresh();
}

onMounted(() => {
  void refresh();
  refreshTimer = setInterval(() => { void refresh(); }, 60_000);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <div class="message-center">
    <button
      type="button"
      class="message-center-trigger"
      ref="trigger"
      :aria-label="t('messages.open')"
      :title="t('messages.open')"
      :aria-expanded="panelOpen"
      aria-controls="message-center-panel"
      @click="openCenter"
    >
      <Icon name="bell" />
      <span v-if="unreadCount" class="message-center-count" :aria-label="t('messages.unreadCount', { count: unreadCount })">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
    </button>

    <Transition name="message-drawer">
      <aside
        v-if="panelOpen"
        ref="panel"
        id="message-center-panel"
        class="message-center-panel"
        role="region"
        tabindex="-1"
        :aria-labelledby="activeView === 'compose' ? 'message-compose-title' : 'message-center-title'"
        @keydown.esc="closeCenter"
      >
        <header class="message-center-header">
          <div>
            <template v-if="activeView === 'compose'">
              <h2 id="message-compose-title">{{ t('messages.composeTitle') }}</h2>
              <p>{{ t('messages.composeDescription') }}</p>
            </template>
            <template v-else>
              <h2 id="message-center-title">{{ t('messages.title') }}</h2>
              <p v-if="unreadCount">{{ t('messages.unreadCount', { count: unreadCount }) }}</p>
            </template>
          </div>
          <div class="message-center-header-actions">
            <button v-if="activeView === 'compose'" type="button" class="message-center-refresh" :aria-label="t('messages.backToInbox')" :title="t('messages.backToInbox')" @click="activeView = 'inbox'"><Icon name="left" /></button>
            <button v-else-if="props.canManageUsers" type="button" class="message-center-refresh" :aria-label="t('messages.send')" :title="t('messages.send')" @click="openComposer"><Icon name="edit" /></button>
            <button v-if="activeView === 'inbox'" type="button" class="message-center-refresh" :disabled="loading" :aria-label="t('messages.refresh')" :title="t('messages.refresh')" @click="refresh"><Icon name="refresh" /></button>
            <button type="button" class="message-center-close" :aria-label="t('common.close')" @click="closeCenter"><Icon name="cross" /></button>
          </div>
        </header>
        <p v-if="error" class="message-center-error" role="alert">{{ error }}</p>
        <form v-if="activeView === 'compose'" class="message-compose" @submit.prevent="send">
          <label>
            <span>{{ t('messages.recipient') }}</span>
            <input v-model="compose.username" class="form-input" required />
          </label>
          <label>
            <span>{{ t('messages.subject') }}</span>
            <input v-model="compose.title" class="form-input" required maxlength="200" />
          </label>
          <label>
            <span>{{ t('messages.body') }}</span>
            <textarea v-model="compose.message" class="form-input" required maxlength="4000" rows="7"></textarea>
            <small>{{ t('messages.markdownSupported') }}</small>
          </label>
          <div class="message-compose-options">
            <label>
              <span>{{ t('messages.kind') }}</span>
              <select v-model="compose.kind" class="form-input">
              <option value="info">{{ t('messages.kinds.info') }}</option>
              <option value="notice">{{ t('messages.kinds.notice') }}</option>
              <option value="warning">{{ t('messages.kinds.warning') }}</option>
              </select>
            </label>
            <label>
              <span>{{ t('messages.presentation') }}</span>
              <select v-model="compose.presentation" class="form-input">
              <option value="inbox">{{ t('messages.presentations.inbox') }}</option>
              <option value="modal">{{ t('messages.presentations.modal') }}</option>
              </select>
            </label>
            <button type="submit" class="btn-primary" :disabled="composeBusy">{{ t('messages.send') }}</button>
          </div>
        </form>
        <p v-else-if="loading && !visibleMessages.length" class="message-center-state">{{ t('common.loading') }}</p>
        <p v-else-if="!visibleMessages.length" class="message-center-state">{{ t('messages.empty') }}</p>
        <div v-else class="message-center-list">
          <article
            v-for="message in visibleMessages"
            :key="message.id"
            class="message-card"
            :class="[`message-card-${messageKind(message)}`, { 'message-card-unread': !message.readAt }]"
          >
            <div class="message-card-heading">
              <span class="message-card-kind">{{ t(`messages.kinds.${messageKind(message)}`) }}</span>
              <time v-if="formatDate(message.createdAt)" :datetime="message.createdAt">{{ formatDate(message.createdAt) }}</time>
            </div>
            <h3>{{ message.title }}</h3>
            <div class="message-body" v-html="message.bodyHtml"></div>
            <footer class="message-card-actions">
              <span v-if="message.source === 'official'" class="message-card-source">{{ t('messages.official') }}</span>
              <span v-else class="message-card-source">{{ t('messages.service') }}</span>
              <span class="message-card-buttons">
                <button v-if="!message.readAt" type="button" class="btn-secondary btn-sm" @click="read(message)">{{ t('messages.markRead') }}</button>
                <button type="button" class="btn-secondary btn-sm" @click="dismiss(message)">{{ t('messages.dismiss') }}</button>
              </span>
            </footer>
          </article>
        </div>
      </aside>
    </Transition>

    <div v-if="modalMessage && !panelOpen" class="message-center-backdrop message-center-modal-backdrop" @click.self="acknowledgeModal">
      <section
        class="card message-modal"
        :class="`message-modal-${messageKind(modalMessage)}`"
        role="alertdialog"
        aria-modal="true"
        :aria-label="modalMessage.title"
        @keydown.esc="acknowledgeModal"
      >
        <span class="message-modal-kind"><Icon :name="messageKind(modalMessage) === 'warning' || messageKind(modalMessage) === 'error' ? 'warn' : 'info'" /> {{ t(`messages.kinds.${messageKind(modalMessage)}`) }}</span>
        <h2>{{ modalMessage.title }}</h2>
        <div class="message-body" v-html="modalMessage.bodyHtml"></div>
        <div class="message-modal-actions">
          <button type="button" class="btn-primary" @click="acknowledgeModal">{{ t('messages.acknowledge') }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.message-center { display: contents; }
.message-center-trigger, .message-center-refresh, .message-center-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: 2.1rem;
  height: 2.1rem;
  padding: 0;
  border: 1px solid var(--color-border-subtle);
  border-radius: 0.4rem;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.message-center-trigger:hover, .message-center-trigger:focus-visible, .message-center-refresh:hover:not(:disabled), .message-center-refresh:focus-visible, .message-center-close:hover, .message-center-close:focus-visible { color: var(--color-accent-primary); border-color: var(--color-accent-primary); }
.message-center-trigger:focus-visible, .message-center-refresh:focus-visible, .message-center-close:focus-visible { outline: 2px solid var(--color-accent-primary); outline-offset: 2px; }
.message-center-count { position: absolute; top: -0.38rem; right: -0.42rem; min-width: 1.05rem; padding: 0 0.22rem; border-radius: 999px; background: var(--color-accent-primary); color: var(--color-text-inverse); font: 700 0.62rem/1.1 var(--font-mono); }
.message-center-backdrop { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 1rem; background: rgb(0 0 0 / 70%); }
.message-center-panel { position: fixed; z-index: 1200; top: 0; right: 0; bottom: 0; display: flex; width: min(31rem, 100vw); flex-direction: column; padding: 1.25rem; overflow: auto; border-left: 1px solid var(--color-border-subtle); background: var(--color-bg-primary); box-shadow: -1.1rem 0 2.7rem rgb(0 0 0 / 30%); }
.message-drawer-enter-active, .message-drawer-leave-active { transition: transform 160ms ease, opacity 160ms ease; }
.message-drawer-enter-from, .message-drawer-leave-to { opacity: 0; transform: translateX(1.5rem); }
.message-center-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.message-center-header h2, .message-modal h2 { margin: 0; font-size: 1.15rem; }
.message-center-header p { margin: 0.3rem 0 0; color: var(--color-text-secondary); font-size: var(--fs-sm); }
.message-center-header-actions, .message-card-buttons { display: flex; gap: 0.45rem; }
.message-center-state, .message-center-error { margin: 1.5rem 0; color: var(--color-text-secondary); text-align: center; }
.message-center-error { color: var(--color-danger, #e66); }
.message-center-list { display: grid; gap: 0.7rem; }
.message-compose { display: grid; gap: 1rem; margin: 0.25rem 0 1rem; }
.message-compose label { display: grid; gap: 0.38rem; color: var(--color-text-secondary); font-size: var(--fs-sm); }
.message-compose small { color: var(--color-text-muted); }
.message-compose textarea { resize: vertical; }
.message-compose-options { display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.55rem; align-items: end; }
.message-card { padding: 0.95rem; border: 1px solid var(--color-border-subtle); border-left: 3px solid var(--color-accent-primary); border-radius: 0.45rem; background: color-mix(in srgb, var(--color-bg-primary) 42%, transparent); }
.message-card-unread { border-color: var(--color-accent-primary); }
.message-card-notice { border-left-color: var(--color-accent-primary); }
.message-card-warning, .message-modal-warning { border-left-color: #e5a93d; }
.message-card-error, .message-modal-error { border-left-color: var(--color-danger, #e66); }
.message-card-heading, .message-card-actions { display: flex; justify-content: space-between; gap: 0.75rem; align-items: center; }
.message-card-heading { margin-bottom: 0.45rem; color: var(--color-text-muted); font-size: var(--fs-xs); }
.message-card-kind, .message-modal-kind { font-family: var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
.message-card h3 { margin: 0; font-size: 0.98rem; }
.message-body { margin: 0.55rem 0 0; color: var(--color-text-secondary); line-height: 1.55; overflow-wrap: anywhere; }
.message-body :deep(p:first-child) { margin-top: 0; }
.message-body :deep(p:last-child) { margin-bottom: 0; }
.message-body :deep(h1), .message-body :deep(h2), .message-body :deep(h3), .message-body :deep(h4) { margin: 1rem 0 0.45rem; color: var(--color-text-primary); font-size: 1em; }
.message-body :deep(ul), .message-body :deep(ol) { margin: 0.6rem 0; padding-left: 1.3rem; }
.message-body :deep(a) { color: var(--color-accent-primary); text-decoration: underline; }
.message-body :deep(code) { padding: 0.1rem 0.28rem; border-radius: 0.2rem; background: color-mix(in srgb, var(--color-bg-secondary) 80%, transparent); font-family: var(--font-mono); font-size: 0.9em; }
.message-body :deep(pre) { overflow-x: auto; padding: 0.7rem; border-radius: 0.35rem; background: color-mix(in srgb, var(--color-bg-secondary) 80%, transparent); }
.message-body :deep(pre code) { padding: 0; background: transparent; }
.message-card-actions { margin-top: 0.85rem; }
.message-card-source { color: var(--color-text-muted); font-size: var(--fs-xs); }
.message-modal { width: min(460px, 100%); padding: 1.25rem; border-left: 4px solid var(--color-accent-primary); }
.message-modal-kind { display: inline-flex; align-items: center; gap: 0.35rem; margin-bottom: 0.75rem; color: var(--color-accent-primary); font-size: var(--fs-xs); }
.message-modal-actions { display: flex; justify-content: flex-end; margin-top: 1.2rem; }
@media (max-width: 720px) { .message-center-panel { width: 100vw; padding: 1rem; border-left: 0; } .message-card-actions { align-items: flex-start; flex-direction: column; } .message-compose-options { grid-template-columns: 1fr; } .message-card-buttons, .message-compose-options button { width: 100%; justify-content: flex-end; } }
</style>
