<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "../stores/player";
import WinChoiceFlyout, { type WinChoice } from "./WinChoiceFlyout.vue";

const { t } = useI18n();
const player = usePlayerStore();

const QUALITY_SELECT_OPTIONS = [
  { id: "auto" },
  { id: "mp3-128", mime: "audio/mpeg" },
  { id: "mp3-192", mime: "audio/mpeg" },
  { id: "aac-128", mime: "audio/mp4; codecs=mp4a.40.2" },
  { id: "opus-128", mime: "audio/ogg; codecs=opus" },
  { id: "flac", mime: "audio/flac" },
  { id: "wav", mime: "audio/wav" },
];

const supportedQualityOptions = computed<WinChoice[]>(() => QUALITY_SELECT_OPTIONS
  .filter((option) => !option.mime || typeof Audio === "undefined" || new Audio().canPlayType(option.mime) !== "")
  .map((option) => ({ id: option.id, label: t(`player.quality.${option.id}`) })));

watch(supportedQualityOptions, (options) => {
  if (!options.some((option) => option.id === player.playbackQuality)) player.playbackQuality = "auto";
}, { immediate: true });
</script>

<template>
  <WinChoiceFlyout
    v-model="player.playbackQuality"
    :choices="supportedQualityOptions"
    :ariaLabel="t('player.quality.title')"
  />
</template>
