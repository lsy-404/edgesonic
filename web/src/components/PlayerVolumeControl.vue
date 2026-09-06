<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "../stores/player";
import Icon from "./Icon.vue";
import { volumePercent, toggledVolume } from "./PlayerVolumeControl";

const { t } = useI18n();
const player = usePlayerStore();

const trigger = ref<HTMLButtonElement | null>(null);
const popup = ref<HTMLElement | null>(null);
const range = ref<HTMLInputElement | null>(null);
const popupOpen = ref(false);
const adjusting = ref(false);
const lastAudible = ref(player.volume > 0 ? player.volume : 0.5);
const popupStyle = ref<Record<string, string>>({});
const percent = computed(() => volumePercent(player.volume));
const volumeIcon = computed(() => player.volume > 0 ? "volume" : "volumeOff");

function isMobileLayout() {
  return window.matchMedia("(max-width: 960px)").matches;
}

function setVolume(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  player.setVolume(value);
  if (value > 0) lastAudible.value = value;
}

function toggleMute() {
  const value = toggledVolume(player.volume, lastAudible.value);
  player.setVolume(value);
  if (value > 0) lastAudible.value = value;
}

function placePopup() {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  popupStyle.value = {
    bottom: `${Math.max(window.innerHeight - rect.top + 10, 12)}px`,
    right: `${Math.max(window.innerWidth - rect.right, 12)}px`,
  };
}

async function openPopup() {
  placePopup();
  popupOpen.value = true;
  await nextTick();
  range.value?.focus();
}

function onSoundButton() {
  if (isMobileLayout()) void openPopup();
  else toggleMute();
}

function closePopup() {
  popupOpen.value = false;
  adjusting.value = false;
  trigger.value?.focus();
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
  if (popupOpen.value) placePopup();
}

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
    <button
      ref="trigger"
      class="player-volume__button"
      type="button"
      :aria-label="t('player.volume')"
      :aria-expanded="popupOpen"
      :title="`${t('player.volume')} (↑ / ↓, M)`"
      @click="onSoundButton"
    >
      <Icon :name="volumeIcon" :size="16" />
    </button>
    <div class="player-volume__desktop-slider">
      <input
        class="player-volume__range"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="player.volume"
        :aria-label="t('player.volume')"
        @input="setVolume"
        @pointerdown="adjusting = true"
        @pointerup="adjusting = false"
        @pointercancel="adjusting = false"
        @keydown="adjusting = true"
        @keyup="adjusting = false"
        @blur="adjusting = false"
      />
      <span v-if="adjusting" class="player-volume__percent" aria-live="polite">{{ percent }}%</span>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="popupOpen" ref="popup" class="player-volume__popup" :style="popupStyle" role="dialog" :aria-label="t('player.volume')">
      <div class="player-volume__popup-header">
        <span>{{ t('player.volume') }}</span>
        <output>{{ percent }}%</output>
      </div>
      <div class="player-volume__popup-slider">
        <input
          ref="range"
          class="player-volume__range player-volume__popup-range"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="player.volume"
          :aria-label="t('player.volume')"
          @input="setVolume"
          @pointerdown="adjusting = true"
          @pointerup="adjusting = false"
          @pointercancel="adjusting = false"
          @keydown="adjusting = true"
          @keyup="adjusting = false"
          @blur="adjusting = false"
        />
        <span v-if="adjusting" class="player-volume__percent" aria-live="polite">{{ percent }}%</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.player-volume { display: flex; align-items: center; gap: 0.45rem; min-width: 0; }
.player-volume__button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  color: var(--color-text-secondary); background: none;
  border: 1px solid var(--color-border-subtle); border-radius: 4px; cursor: pointer;
}
.player-volume__button:hover, .player-volume__button:focus-visible { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.player-volume__desktop-slider { position: relative; display: flex; align-items: center; }
.player-volume__range { width: clamp(160px, 14vw, 200px); accent-color: var(--color-accent-primary); cursor: pointer; }
.player-volume__percent {
  position: absolute; right: 0; top: calc(100% + 0.1rem);
  color: var(--color-text-muted); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1;
}
.player-volume__popup {
  position: fixed; z-index: 320;
  width: min(22rem, calc(100vw - 2rem)); padding: 0.9rem 1rem 1rem;
  background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong);
  border-radius: 8px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
.player-volume__popup-header { display: flex; justify-content: space-between; margin-bottom: 0.6rem; color: var(--color-text-primary); font-size: var(--fs-sm); }
.player-volume__popup-header output { color: var(--color-text-muted); font-family: var(--font-mono); }
.player-volume__popup-slider { position: relative; min-height: 2rem; }
.player-volume__popup-range { width: 100%; }
@media (max-width: 960px) { .player-volume__desktop-slider { display: none; } }
</style>
