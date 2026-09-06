<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "../stores/player";
import Icon from "./Icon.vue";
import { volumePercent, toggledVolume } from "./PlayerVolumeControl";
import { WinButton } from "../vendor/winui";

const { t } = useI18n();
const player = usePlayerStore();

const trigger = ref<HTMLElement | null>(null);
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
  range.value?.focus();
}

function onSoundButton() {
  if (isMobileLayout()) void openPopup();
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
  if (popupOpen.value) placePopup();
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
      <WinButton
        class="player-volume__button"
        :aria-label="t('player.volume')"
        :aria-expanded="popupOpen"
        :title="`${t('player.volume')} (↑ / ↓, M)`"
        Width="28"
        Height="28"
        Padding="0"
        @Click="onSoundButton"
      >
        <Icon :name="volumeIcon" :size="16" />
      </WinButton>
    </div>
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
    <div v-if="popupOpen" ref="popup" class="player-volume__popup" :style="popupStyle" role="dialog" :aria-label="t('player.volume')" @keydown.escape.stop.prevent="closePopup">
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
.player-volume :deep(.player-volume__button) {
  color: var(--color-text-secondary); border-color: var(--color-border-subtle);
}
.player-volume :deep(.player-volume__button:hover), .player-volume :deep(.player-volume__button:focus-visible) { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.player-volume__desktop-slider { position: relative; display: flex; align-items: flex-start; height: 42px; }
.player-volume__range {
  width: clamp(160px, 14vw, 200px); height: 20px; margin: 0;
  appearance: none; border-radius: 999px; background: transparent; cursor: pointer;
}
.player-volume__range::-webkit-slider-runnable-track { height: 4px; border-radius: 999px; background: var(--ctrl-fill-tertiary, var(--color-bg-tertiary)); }
.player-volume__range::-webkit-slider-thumb { width: 12px; height: 12px; margin-top: -4px; appearance: none; border: 2px solid var(--color-bg-elevated); border-radius: 50%; background: var(--accent-base, var(--color-accent-primary)); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.player-volume__range::-moz-range-track { height: 4px; border: 0; border-radius: 999px; background: var(--ctrl-fill-tertiary, var(--color-bg-tertiary)); }
.player-volume__range::-moz-range-progress { height: 4px; border-radius: 999px; background: var(--accent-base, var(--color-accent-primary)); }
.player-volume__range::-moz-range-thumb { width: 8px; height: 8px; border: 2px solid var(--color-bg-elevated); border-radius: 50%; background: var(--accent-base, var(--color-accent-primary)); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.player-volume__range:focus-visible { outline: 2px solid var(--accent-base, var(--color-accent-primary)); outline-offset: 3px; }
.player-volume__percent {
  position: absolute; right: 0; bottom: 0;
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
.player-volume__popup-slider { position: relative; min-height: 2.5rem; }
.player-volume__popup-range { width: 100%; }
@media (max-width: 960px) { .player-volume__desktop-slider { display: none; } }
</style>
