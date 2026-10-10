<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { convertWavFile, type ConvertedWavFile } from "../lib/wavFlacConvert";
import Icon from "./Icon.vue";

const { locale } = useI18n();
const chinese = computed(() => locale.value.toLowerCase().startsWith("zh"));
const selected = ref<File | null>(null);
const converted = ref<ConvertedWavFile | null>(null);
const busy = ref(false);
const progress = ref(0);
const error = ref("");
const downloadUrl = ref("");

function clearResult() {
  if (downloadUrl.value) URL.revokeObjectURL(downloadUrl.value);
  downloadUrl.value = "";
  converted.value = null;
}

function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement;
  selected.value = input.files?.[0] ?? null;
  error.value = "";
  clearResult();
}

async function convert() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  progress.value = 0;
  error.value = "";
  clearResult();
  try {
    converted.value = await convertWavFile(selected.value, (value) => { progress.value = value; });
    downloadUrl.value = URL.createObjectURL(converted.value.file);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

const percentSaved = computed(() => {
  if (!converted.value || converted.value.sourceBytes === 0) return 0;
  return Math.round((1 - converted.value.outputBytes / converted.value.sourceBytes) * 100);
});

function formatBytes(value: number) {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

onBeforeUnmount(clearResult);
</script>

<template>
  <section class="settings-section card wav-flac-section">
    <div class="section-header wav-flac-header">
      <span class="section-heading"><span class="section-icon"><Icon name="music" size="18" /></span><span class="section-title">{{ chinese ? "WAV 转 FLAC" : "WAV to FLAC" }}</span></span>
    </div>
    <div class="wav-flac-tool">
    <p class="feature-desc">
      {{ chinese ? "在浏览器本地转换整数 PCM WAV。逐样本验证音频，并核对采样率、声道、位深、标签、封面和歌词后才提供下载。" : "Convert integer PCM WAV files in your browser. The tool checks every decoded sample, stream properties, tags, cover art, and lyrics before offering a download." }}
    </p>
    <p class="feature-desc muted">
      {{ chinese ? "首次使用会从 jsDelivr 加载约 31 MB 的 FFmpeg 音频引擎；音频文件只在本机处理。浮点 WAV 和无法验证的元数据会被拒绝。" : "First use downloads the approximately 31 MB FFmpeg audio engine from jsDelivr. Audio stays on this device. Float WAV and metadata that cannot be verified are rejected." }}
    </p>
    <div class="wav-flac-controls">
      <input type="file" accept=".wav,audio/wav,audio/wave" :disabled="busy" @change="chooseFile" />
      <span v-if="selected" class="wav-flac-filename">{{ selected.name }} · {{ formatBytes(selected.size) }}</span>
      <button type="button" class="btn-primary btn-sm" :disabled="!selected || busy" @click="convert">
        {{ busy ? (chinese ? "正在转换…" : "Converting…") : (chinese ? "转换并验证" : "Convert and verify") }}
      </button>
    </div>
    <div v-if="busy" class="wav-flac-progress" role="status" aria-live="polite">
      <progress :value="progress" max="100" /> <span>{{ progress }}%</span>
    </div>
    <p v-if="error" class="wav-flac-error" role="alert">{{ error }}</p>
    <div v-if="converted" class="wav-flac-result" role="status">
      <span>{{ formatBytes(converted.outputBytes) }} · {{ percentSaved >= 0 ? (chinese ? `节省 ${percentSaved}%` : `saved ${percentSaved}%`) : (chinese ? `增加 ${Math.abs(percentSaved)}%` : `${Math.abs(percentSaved)}% larger`) }}</span>
      <a class="btn-secondary btn-sm" :href="downloadUrl" :download="converted.file.name">{{ chinese ? "下载已验证 FLAC" : "Download verified FLAC" }}</a>
    </div>
    </div>
  </section>
</template>

<style scoped>
.wav-flac-tool { display: grid; gap: .7rem; }
.wav-flac-section { padding-bottom: .9rem; }
.wav-flac-header { cursor: default; }
.wav-flac-controls, .wav-flac-result, .wav-flac-progress { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; }
.wav-flac-filename { color: var(--color-text-secondary); overflow-wrap: anywhere; }
.wav-flac-progress progress { width: min(24rem, 70%); }
.wav-flac-error { color: var(--color-danger, #c42b1c); margin: 0; }
.wav-flac-result { justify-content: space-between; }
</style>
