<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "../stores/player";
import Icon from "./Icon.vue";
import { volumePercent, toggledVolume } from "./PlayerVolumeControl";
import { FluentButton, FluentSlider } from "@lsypkg/fluent/vue";

const { t } = useI18n();
const player = usePlayerStore();

const trigger = ref<HTMLElement | null>(null);
const popup = ref<HTMLElement | null>(null);
const range = ref<HTMLElement | null>(null);
const popupOpen = ref(false);
const adjusting = ref(false);
const lastAudible = ref(player.volume > 0 ? player.volume : 0.5);
const popupStyle = ref<Record<string, string>>({});
const percent = computed(() => volumePercent(player.volume));
const volumeIcon = computed(() => player.volume > 0 ? "volume" : "volumeOff");

function isMobileLayout() {
  return window.matchMedia("(max-width: 960px)").matches;
}

function setVolume(value: number) {
  player.setVolume(value);
}

function toggleMute() {
  const value = toggledVolume(player.volume, lastAudible.value);
  player.setVolume(value);
}

function placePopup() {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  const width = Math.min(352, window.innerWidth - 32);
  const left = Math.min(Math.max(rect.right - width, 16), window.innerWidth - width - 16);
  popupStyle.value = {
    bottom: `${Math.max(window.innerHeight - rect.top + 10, 12)}px`,
    left: `${left}px`,
  };
}

async function openPopup() {
  placePopup();
  popupOpen.value = true;
  await nextTick();
  range.value?.querySelector<HTMLInputElement>("input[type='range']")?.focus();
}

function onSoundButton() {
  if (isMobileLayout()) {
    if (popupOpen.value) closePopup();
    else void openPopup();
  }
  else toggleMute();
}

function closePopup() {
  popupOpen.value = false;
  adjusting.value = false;
  trigger.value?.querySelector<HTMLButtonElement>("button")?.focus();
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!popupOpen.value || popup.value?.contains(event.target as Node) || trigger.value?.contains(event.target as Node)) return;
  closePopup();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !popupOpen.value) return;
  event.preventDefault();
  event.stopPropagation();
  closePopup();
}

function onWindowResize() {
  if (!popupOpen.value) return;
  if (isMobileLayout()) placePopup();
  else closePopup();
}

function onRangeFocusOut(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) adjusting.value = false;
}

watch(() => player.volume, (value) => {
  if (value > 0) lastAudible.value = value;
}, { immediate: true });

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
});
</script>

<template>
  <div class="player-volume">
    <div ref="trigger">
      <FluentButton
        class="player-volume__button"
        :aria-label="t('player.volume')"
        :aria-expanded="popupOpen"
        :title="`${t('player.volume')} (↑ / ↓, M)`"
        style="width: 28px; height: 28px; min-height: 28px; padding: 0"
        @click="onSoundButton"
      >
        <Icon :name="volumeIcon" :size="16" />
      </FluentButton>
    </div>
    <div class="player-volume__desktop-slider" @focusin="adjusting = true" @focusout="onRangeFocusOut">
      <FluentSlider
        class="player-volume__range"
        :model-value="player.volume"
        :min="0"
        :max="1"
        :step="0.01"
        style="width: clamp(160px, 14vw, 200px)"
        :aria-label="t('player.volume')"
        @pointerdown="adjusting = true"
        @pointerup="adjusting = false"
        @pointercancel="adjusting = false"
        @lostpointercapture="adjusting = false"
        @update:model-value="setVolume"
      />
      <span v-if="adjusting" class="player-volume__percent" aria-live="polite">{{ percent }}%</span>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="popupOpen" ref="popup" class="player-volume__popup" :style="popupStyle" role="dialog" :aria-label="t('player.volume')" @keydown.escape.stop.prevent="closePopup">
      <div class="player-volume__popup-header">
        <span>{{ t('player.volume') }}</span>
      </div>
      <div ref="range" class="player-volume__popup-slider" @focusin="adjusting = true" @focusout="onRangeFocusOut">
      <FluentSlider
          style="width: 100%"
          :model-value="player.volume"
          :min="0"
          :max="1"
          :step="0.01"
          :aria-label="t('player.volume')"
          @pointerdown="adjusting = true"
          @pointerup="adjusting = false"
          @pointercancel="adjusting = false"
          @lostpointercapture="adjusting = false"
          @update:model-value="setVolume"
        />
        <span v-if="adjusting" class="player-volume__percent" aria-live="polite">{{ percent }}%</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.player-volume { display: flex; align-items: center; gap: 0.45rem; min-width: 0; }
.player-volume :deep(.player-volume__button) {
  color: var(--color-text-secondary); border-color: var(--color-border-subtle);
}
.player-volume :deep(.player-volume__button:hover), .player-volume :deep(.player-volume__button:focus-visible) { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.player-volume__desktop-slider:focus-within, .player-volume__popup-slider:focus-within { outline: 2px solid var(--accent-base); outline-offset: 3px; border-radius: 4px; }
.player-volume__desktop-slider {
  position: relative; display: flex; align-items: center; height: 28px;
  padding-right: 4.5ch; box-sizing: content-box;
}
.player-volume__percent {
  position: absolute; right: 0; bottom: 50%; transform: translateY(50%);
  width: 4ch; text-align: right;
  color: var(--color-text-muted); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1;
}
.player-volume__popup {
  position: fixed; z-index: 320;
  width: min(352px, calc(100vw - 32px)); padding: 0.9rem 1rem 1rem;
  background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong);
  border-radius: 8px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
.player-volume__popup-header { display: flex; justify-content: space-between; margin-bottom: 0.6rem; color: var(--color-text-primary); font-size: var(--fs-sm); }
.player-volume__popup-slider { position: relative; min-height: 48px; }
@media (max-width: 960px) { .player-volume__desktop-slider { display: none; } }
</style>
