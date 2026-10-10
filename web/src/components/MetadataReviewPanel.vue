<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import {
  metadataReviewRequest,
  metadataSnapshotFields,
  parseAutoState,
  parseMetadataReviewPage,
  type MetadataReviewCandidate,
  type MetadataReviewItem,
} from "../lib/metadataReview";
import { resolveMetadataRetrievalCandidate, type MetadataRetrievalPayload, type MetadataRetrievalMatch } from "../lib/workmodeMetadataRetrieval";

const { t } = useI18n();
const { edgesonicFetch, edgesonicPost } = useAuth();
const enabled = ref(false);
const counts = ref({ total: 0, incomplete: 0, complete: 0, pending: 0, kept: 0, queued: 0, claimed: 0 });
const items = ref<MetadataReviewItem[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const changingEnabled = ref(false);
const errors = ref<string | null>(null);
const busyTasks = ref(new Set<string>());
const refreshPending = ref(false);
let mounted = false;
let pollTimer: number | null = null;
let statusController: AbortController | null = null;
const actionControllers = new Set<AbortController>();

function scheduleRefresh(): void {
  if (!mounted || document.hidden || pollTimer !== null) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    if (busyTasks.value.size > 0) { scheduleRefresh(); return; }
    void refreshStatus(true).finally(scheduleRefresh);
  }, 60_000);
}

async function readStatus(after?: string | null, signal?: AbortSignal): Promise<void> {
  const params = after ? { after } : undefined;
  const page = parseMetadataReviewPage(JSON.parse(await edgesonicFetch("work/scrape/status", params, signal)) as unknown);
  if (signal?.aborted || !mounted) return;
  enabled.value = page.autoEnabled;
  counts.value = page.counts;
  if (after) items.value = [...items.value, ...page.pending.filter((item) => !items.value.some((existing) => existing.taskId === item.taskId))];
  else items.value = page.pending;
  nextCursor.value = page.nextCursor;
}

async function refreshStatus(reset = true): Promise<void> {
  if (!mounted || statusController) return;
  loading.value = true;
  const controller = new AbortController();
  statusController = controller;
  try {
    if (reset) await readStatus(null, controller.signal);
    else await readStatus(nextCursor.value, controller.signal);
    errors.value = null;
  } catch (error) {
    if (!controller.signal.aborted && mounted) errors.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (statusController === controller) statusController = null;
    if (mounted) loading.value = false;
  }
}

async function refreshAfterMutation(): Promise<void> {
  statusController?.abort();
  statusController = null;
  await refreshStatus(true);
}

async function refreshWhenIdle(): Promise<void> {
  refreshPending.value = true;
  if (busyTasks.value.size > 0) return;
  refreshPending.value = false;
  await refreshAfterMutation();
}

async function flushPendingRefresh(): Promise<void> {
  if (refreshPending.value && busyTasks.value.size === 0) {
    refreshPending.value = false;
    await refreshAfterMutation();
  }
}

async function loadMore(): Promise<void> {
  if (loadingMore.value || busyTasks.value.size > 0 || !nextCursor.value) return;
  loadingMore.value = true;
  await refreshStatus(false);
  loadingMore.value = false;
}

function pauseStatusForDecision(): void {
  statusController?.abort();
  statusController = null;
  loading.value = false;
}

async function setAutomaticRetrieval(): Promise<void> {
  if (changingEnabled.value) return;
  changingEnabled.value = true;
  errors.value = null;
  const controller = new AbortController();
  actionControllers.add(controller);
  try {
    const next = !enabled.value;
    const body = JSON.parse(await edgesonicPost("work/scrape/auto", { enabled: next }, controller.signal)) as unknown;
    enabled.value = parseAutoState(body);
    await refreshWhenIdle();
  } catch (error) {
    if (!controller.signal.aborted) errors.value = error instanceof Error ? error.message : String(error);
  } finally {
    actionControllers.delete(controller);
    changingEnabled.value = false;
  }
}

function currentFields(item: MetadataReviewItem): Record<string, string> {
  return metadataSnapshotFields(item.payload);
}

function reasonLabel(reason?: string): string {
  if (reason === "ambiguous") return t("workMode.metadataReasonAmbiguous");
  if (reason === "no-credible-match") return t("workMode.metadataReasonNoMatch");
  return t("workMode.metadataReasonUnknown");
}

function candidateLabel(candidate: MetadataReviewCandidate): string {
  return [candidate.title, candidate.artist, candidate.album].filter(Boolean).join(" · ");
}

async function decide(item: MetadataReviewItem, decision: "keep" | "retry"): Promise<void> {
  if (busyTasks.value.has(item.taskId)) return;
  pauseStatusForDecision();
  const controller = new AbortController();
  actionControllers.add(controller);
  const nextBusy = new Set(busyTasks.value);
  nextBusy.add(item.taskId);
  busyTasks.value = nextBusy;
  errors.value = null;
  let reviewApplied = false;
  try {
    const body = metadataReviewRequest(item, decision);
    const response = JSON.parse(await edgesonicPost("work/scrape/review", body, controller.signal)) as { ok?: boolean; error?: string };
    if (!response.ok) throw new Error(response.error || "Review action failed");
    reviewApplied = true;
  } catch (error) {
    if (!controller.signal.aborted && mounted) errors.value = error instanceof Error ? error.message : String(error);
  } finally {
    actionControllers.delete(controller);
    const settled = new Set(busyTasks.value);
    settled.delete(item.taskId);
    busyTasks.value = settled;
  }
  if (reviewApplied) refreshPending.value = true;
  if (mounted) await flushPendingRefresh();
}

async function applyCandidate(item: MetadataReviewItem, candidateIndex: number): Promise<void> {
  if (busyTasks.value.has(item.taskId)) return;
  pauseStatusForDecision();
  const controller = new AbortController();
  actionControllers.add(controller);
  const nextBusy = new Set(busyTasks.value);
  nextBusy.add(item.taskId);
  busyTasks.value = nextBusy;
  errors.value = null;
  let reviewApplied = false;
  try {
    const proxyUrl = new URL("/tag/scrape", window.location.origin).toString();
    const result = await resolveMetadataRetrievalCandidate(
      item.payload as unknown as MetadataRetrievalPayload,
      item.result.candidates[candidateIndex] as MetadataRetrievalMatch,
      proxyUrl,
      controller.signal,
    );
    const body = metadataReviewRequest(item, "apply", candidateIndex, result);
    const response = JSON.parse(await edgesonicPost("work/scrape/review", body, controller.signal)) as { ok?: boolean; error?: string };
    if (!response.ok) throw new Error(response.error || "Review action failed");
    reviewApplied = true;
  } catch (error) {
    if (!controller.signal.aborted && mounted) errors.value = error instanceof Error ? error.message : String(error);
  } finally {
    actionControllers.delete(controller);
    const settled = new Set(busyTasks.value);
    settled.delete(item.taskId);
    busyTasks.value = settled;
  }
  if (reviewApplied) refreshPending.value = true;
  if (mounted) await flushPendingRefresh();
}

function onVisibility(): void {
  if (document.hidden) {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    statusController?.abort();
    statusController = null;
  } else {
    if (busyTasks.value.size > 0) refreshPending.value = true;
    else void refreshStatus(true).finally(scheduleRefresh);
  }
}

onMounted(async () => {
  mounted = true;
  document.addEventListener("visibilitychange", onVisibility);
  const controller = new AbortController();
  actionControllers.add(controller);
  try {
    const auto = parseAutoState(JSON.parse(await edgesonicFetch("work/scrape/auto", undefined, controller.signal)) as unknown);
    if (!mounted || controller.signal.aborted) return;
    enabled.value = auto;
    await refreshAfterMutation();
  } catch (error) {
    if (mounted && !controller.signal.aborted) errors.value = error instanceof Error ? error.message : String(error);
  } finally {
    actionControllers.delete(controller);
    scheduleRefresh();
  }
});
onBeforeUnmount(() => {
  mounted = false;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  statusController?.abort();
  for (const controller of actionControllers) controller.abort();
  document.removeEventListener("visibilitychange", onVisibility);
});
</script>

<template>
  <section class="metadata-review">
    <header class="review-head">
      <div>
        <h2>{{ t("workMode.autoMetadataTitle") }}</h2>
        <p>{{ t("workMode.autoMetadataHelp") }}</p>
      </div>
      <button type="button" :disabled="changingEnabled || busyTasks.size > 0" :aria-pressed="enabled" @click="setAutomaticRetrieval">
        {{ changingEnabled ? t("common.loading") : enabled ? t("workMode.autoMetadataStop") : t("workMode.autoMetadataStart") }}
      </button>
    </header>
    <p class="review-note">{{ t("workMode.autoMetadataParticipantNote") }}</p>
    <p class="review-note">{{ t("workMode.metadataCompletenessNote") }}</p>
    <div class="count-group" aria-live="polite">
      <h3>{{ t("workMode.metadataCompletenessHeading") }}</h3>
      <div class="metadata-counts">
        <div><span>{{ t("workMode.metadataTotal") }}</span><b>{{ counts.total }}</b></div>
        <div><span>{{ t("workMode.metadataIncomplete") }}</span><b>{{ counts.incomplete }}</b></div>
        <div><span>{{ t("workMode.metadataComplete") }}</span><b>{{ counts.complete }}</b></div>
      </div>
    </div>
    <div class="count-group" aria-live="polite">
      <h3>{{ t("workMode.metadataTaskHeading") }}</h3>
      <div class="metadata-counts">
        <div><span>{{ t("workMode.metadataPending") }}</span><b>{{ counts.pending }}</b></div>
        <div><span>{{ t("workMode.metadataKept") }}</span><b>{{ counts.kept }}</b></div>
        <div><span>{{ t("workMode.metadataQueued") }}</span><b>{{ counts.queued }}</b></div>
        <div><span>{{ t("workMode.metadataClaimed") }}</span><b>{{ counts.claimed }}</b></div>
      </div>
    </div>
    <p v-if="loading" role="status">{{ t("common.loading") }}</p>
    <p v-if="errors" class="review-error" role="alert">{{ t("workMode.metadataReviewError", { reason: errors }) }}</p>
    <div v-for="item in items" :key="item.taskId" class="review-item">
      <div class="review-current">
        <strong>{{ t("workMode.metadataCurrent") }}</strong>
        <span>{{ currentFields(item).title || "—" }} · {{ currentFields(item).artist || "—" }} · {{ currentFields(item).album || "—" }}</span>
        <small>{{ reasonLabel(item.result.reason) }}</small>
      </div>
      <div v-for="(candidate, index) in item.result.candidates" :key="`${candidate.source}:${candidate.songId}`" class="review-candidate">
        <div>
          <strong>{{ candidateLabel(candidate) }}</strong>
          <small>{{ t("workMode.metadataCandidateSource", { source: candidate.source }) }}</small>
        </div>
        <button type="button" :disabled="busyTasks.has(item.taskId)" @click="applyCandidate(item, index)">
          {{ t("workMode.metadataApplyCandidate") }}
        </button>
      </div>
      <div class="review-actions">
        <button type="button" :disabled="busyTasks.has(item.taskId)" @click="decide(item, 'keep')">{{ t("workMode.metadataKeepExisting") }}</button>
        <button type="button" :disabled="busyTasks.has(item.taskId)" @click="decide(item, 'retry')">{{ t("workMode.metadataSearchAgain") }}</button>
      </div>
    </div>
    <p v-if="!loading && items.length === 0 && counts.pending === 0" class="review-note">{{ t("workMode.metadataNoPending") }}</p>
    <button v-if="nextCursor" type="button" :disabled="loading || loadingMore || busyTasks.size > 0" @click="loadMore">
      {{ loadingMore ? t("common.loading") : t("workMode.metadataLoadMore") }}
    </button>
  </section>
</template>

<style scoped>
.metadata-review { border: 1px solid var(--color-border-subtle); padding: .8rem; margin: 1rem 0; font-size: .85rem; }
.review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
.review-head h2 { margin: 0; font-size: 1rem; }
.review-head p, .review-note { margin: .45rem 0; color: var(--color-text-secondary); line-height: 1.45; }
.metadata-review button { border: 1px solid var(--color-border-subtle); background: var(--color-bg-secondary); color: var(--color-text-primary); border-radius: .3rem; padding: .35rem .55rem; cursor: pointer; }
.metadata-review button:disabled { opacity: .5; cursor: wait; }
.count-group h3 { margin: .65rem 0 .25rem; font-size: .82rem; font-weight: 600; color: var(--color-text-secondary); }
.metadata-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr)); gap: 1px; background: var(--color-border); margin: .75rem 0; }
.metadata-counts div { display: flex; flex-direction: column; gap: .2rem; padding: .5rem; background: var(--color-bg); }
.metadata-counts span, .review-current small, .review-candidate small { color: var(--color-text-secondary); font-size: .75rem; }
.review-item { border-top: 1px solid var(--color-border-subtle); padding: .7rem 0; display: grid; gap: .5rem; }
.review-current, .review-candidate { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .5rem; }
.review-current { display: grid; justify-content: start; }
.review-candidate > div { display: grid; gap: .15rem; min-width: 0; overflow-wrap: anywhere; }
.review-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.review-error { color: var(--color-danger, #b42318); }
</style>
