<script setup lang="ts">
import { computed, ref, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  Value?: number;
  Minimum?: number;
  Maximum?: number;
  SmallChange?: number;
  StepFrequency?: number;
  IsEnabled?: boolean;
  modelValue?: number;
  min?: number;
  max?: number;
  step?: number;
  Width?: string | number;
  Height?: string | number;
  AriaLabel?: string;
}>(), {
  Value: 0,
  Minimum: 0,
  Maximum: 100,
  SmallChange: 1,
  StepFrequency: 1,
  IsEnabled: true,
});
const emit = defineEmits<{
  "update:Value": [value: number];
  "update:modelValue": [value: number];
  ValueChanged: [value: { OldValue: number; NewValue: number }];
  InteractionStarted: [];
  InteractionCompleted: [];
}>();
const attrs = useAttrs();

const track = ref<HTMLElement | null>(null);
const pressed = ref(false);
const minimum = computed(() => props.min ?? props.Minimum);
const maximum = computed(() => Math.max(minimum.value, props.max ?? props.Maximum));
const step = computed(() => Math.max(0.0001, props.step ?? props.StepFrequency));
const value = computed(() => Math.min(maximum.value, Math.max(minimum.value, props.modelValue ?? props.Value)));
const percent = computed(() => ((value.value - minimum.value) / Math.max(maximum.value - minimum.value, 0.0001)) * 100);
const sliderStyle = computed(() => ({
  width: typeof props.Width === "number" ? `${props.Width}px` : props.Width || "200px",
  height: typeof props.Height === "number" ? `${props.Height}px` : props.Height || "32px",
}));
const fillStyle = computed(() => ({ width: `calc(${percent.value}% - ${(percent.value * 18) / 100}px)` }));
const thumbStyle = computed(() => ({ left: `calc(9px + ${percent.value}% - ${(percent.value * 18) / 100}px)` }));

function commit(next: number) {
  const snapped = minimum.value + Math.round((next - minimum.value) / step.value) * step.value;
  const clamped = Math.min(maximum.value, Math.max(minimum.value, Number(snapped.toFixed(4))));
  emit("update:Value", clamped);
  emit("update:modelValue", clamped);
  if (clamped !== value.value) emit("ValueChanged", { OldValue: value.value, NewValue: clamped });
}

function valueFromPointer(event: PointerEvent) {
  const rect = track.value?.getBoundingClientRect();
  if (!rect) return;
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - 9) / Math.max(1, rect.width - 18)));
  commit(minimum.value + ratio * (maximum.value - minimum.value));
}

function onPointerDown(event: PointerEvent) {
  if (!props.IsEnabled || !track.value) return;
  pressed.value = true;
  emit("InteractionStarted");
  track.value.setPointerCapture(event.pointerId);
  valueFromPointer(event);
}

function onPointerMove(event: PointerEvent) {
  if (pressed.value) valueFromPointer(event);
}

function stopPointer(event: PointerEvent) {
  pressed.value = false;
  emit("InteractionCompleted");
  if (track.value?.hasPointerCapture(event.pointerId)) track.value.releasePointerCapture(event.pointerId);
}

function onKeydown(event: KeyboardEvent) {
  if (!props.IsEnabled) return;
  const delta = event.key === "ArrowRight" || event.key === "ArrowUp" ? step.value
    : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step.value : 0;
  if (delta) {
    event.preventDefault();
    emit("InteractionStarted");
    commit(value.value + delta);
  } else if (event.key === "Home") {
    event.preventDefault();
    emit("InteractionStarted");
    commit(minimum.value);
  } else if (event.key === "End") {
    event.preventDefault();
    emit("InteractionStarted");
    commit(maximum.value);
  }
}
</script>

<template>
  <div class="win-slider-root" :class="[attrs.class, { 'is-disabled': !IsEnabled }]" :style="attrs.style">
    <div
      ref="track"
      class="win-slider"
      :style="sliderStyle"
      role="slider"
      :tabindex="IsEnabled ? 0 : -1"
      :aria-valuemin="minimum"
      :aria-valuemax="maximum"
      :aria-valuenow="value"
      :aria-disabled="!IsEnabled || undefined"
      :aria-label="AriaLabel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="stopPointer"
      @pointercancel="stopPointer"
      @keydown="onKeydown"
      @keyup="emit('InteractionCompleted')"
    >
      <div class="win-slider-track"><div class="win-slider-fill" :style="fillStyle" /></div>
      <div class="win-slider-thumb" :class="{ 'is-pressed': pressed }" :style="thumbStyle" />
    </div>
  </div>
</template>

<style>
.win-slider-root { display: inline-flex; flex-direction: column; align-items: flex-start; }
.win-slider { position: relative; display: flex; align-items: center; min-width: 32px; min-height: 32px; touch-action: none; cursor: pointer; }
.win-slider:focus-visible { outline: 2px solid var(--accent-base); outline-offset: 2px; }
.win-slider-track { position: absolute; left: 0; right: 0; top: 50%; height: 4px; transform: translateY(-50%); overflow: hidden; border-radius: 2px; background: var(--ctrl-strong-fill, var(--ctrl-fill-tertiary)); }
.win-slider-fill { height: 100%; border-radius: 2px; background: var(--accent-base); }
.win-slider-thumb { position: absolute; top: 50%; width: 22px; height: 22px; transform: translate(-50%, -50%); display: grid; place-items: center; border: 1px solid var(--ControlStrokeColorDefaultBrush, var(--ctrl-border)); border-radius: 50%; background: var(--SliderOuterThumbBackground, var(--ctrl-fill-default)); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }
.win-slider-thumb::after { content: ""; width: 12px; height: 12px; border-radius: 50%; background: var(--accent-base); transform: scale(.86); transition: transform var(--fast-duration) var(--fast-out-slow-in); }
.win-slider:hover .win-slider-thumb::after { background: var(--accent-hover); transform: scale(1.167); }
.win-slider-thumb.is-pressed::after { background: var(--accent-pressed); transform: scale(.71); }
.win-slider-root.is-disabled { opacity: .6; cursor: default; }
</style>
