<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type CSSProperties } from "vue";
import { isScrollInsideElement, placeFloatingMenu, type FloatingPlacement } from "../lib/floatingPlacement";
import { WinButton } from "../vendor/winui";
import Icon from "./Icon.vue";

export interface WinChoice {
  id: string;
  label: string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  choices: WinChoice[];
  ariaLabel: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const open = ref(false);
const instanceId = useId();
const listboxId = `win-choice-listbox-${instanceId}`;
const triggerEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const menuPlaced = ref(false);
const activeId = ref(props.modelValue);
const menuPlacement = ref<FloatingPlacement>({ left: 0, top: 0, maxHeight: 0, placement: "bottom" });

const selectedChoice = computed(() => props.choices.find((choice) => choice.id === props.modelValue) ?? props.choices[0]);
const activeChoiceIndex = computed(() => Math.max(0, props.choices.findIndex((choice) => choice.id === activeId.value)));
const activeDescendant = computed(() => optionDomId(activeId.value));
const menuStyle = computed<CSSProperties>(() => ({
  left: `${menuPlacement.value.left}px`,
  top: `${menuPlacement.value.top}px`,
  maxHeight: menuPlaced.value ? `${menuPlacement.value.maxHeight}px` : "none",
  minWidth: `${triggerEl.value?.getBoundingClientRect().width ?? 0}px`,
  visibility: menuPlaced.value ? "visible" : "hidden",
}));

function focusTrigger() {
  triggerEl.value?.querySelector<HTMLButtonElement>("button")?.focus();
}

function optionDomId(choiceId: string) {
  return `win-choice-option-${instanceId}-${choiceId}`;
}

function revealActiveChoice() {
  document.getElementById(optionDomId(activeId.value))?.scrollIntoView({ block: "nearest" });
}

function closeMenu(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) void nextTick(focusTrigger);
}

function selectChoice(choice: WinChoice) {
  if (choice.disabled) return;
  activeId.value = choice.id;
  emit("update:modelValue", choice.id);
  closeMenu(true);
}

function enabledIndex(start: number, direction: number): number {
  const choices = props.choices;
  if (!choices.length) return -1;
  for (let offset = 1; offset <= choices.length; offset++) {
    const index = (start + direction * offset + choices.length) % choices.length;
    if (!choices[index].disabled) return index;
  }
  return -1;
}

function setBoundary(first: boolean) {
  const choices = first ? props.choices : [...props.choices].reverse();
  const choice = choices.find((item) => !item.disabled);
  if (choice) activeId.value = choice.id;
}

function moveActive(direction: number) {
  const index = enabledIndex(activeChoiceIndex.value, direction);
  if (index >= 0) activeId.value = props.choices[index].id;
}

async function updateMenuPlacement() {
  if (!open.value) return;
  menuPlaced.value = false;
  await nextTick();
  const trigger = triggerEl.value;
  const list = listEl.value;
  if (!trigger || !list || !open.value) return;
  menuPlacement.value = placeFloatingMenu(trigger.getBoundingClientRect(), list.getBoundingClientRect(), {
    align: "right",
    gap: 4,
    margin: 8,
    minHeight: 120,
  });
  menuPlaced.value = true;
}

async function openMenu(focusList = true) {
  if (!props.choices.some((choice) => !choice.disabled)) return;
  activeId.value = selectedChoice.value?.id ?? props.choices[0]?.id ?? "";
  open.value = true;
  await updateMenuPlacement();
  if (focusList) listEl.value?.focus();
}

function toggleMenu() {
  if (open.value) closeMenu();
  else void openMenu();
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    void openMenu();
    if (event.key === "Home") setBoundary(true);
    else if (event.key === "End") setBoundary(false);
    else moveActive(event.key === "ArrowDown" ? 1 : -1);
  }
}

function onListKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveActive(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    setBoundary(event.key === "Home");
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const choice = props.choices[activeChoiceIndex.value];
    if (choice) selectChoice(choice);
  } else if (event.key === "Tab") {
    closeMenu();
  }
}

function onFocusOut(event: FocusEvent) {
  if (!open.value) return;
  const nextFocus = event.relatedTarget as Node | null;
  if (nextFocus && (triggerEl.value?.contains(nextFocus) || listEl.value?.contains(nextFocus))) return;
  closeMenu();
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && (triggerEl.value?.contains(target) || listEl.value?.contains(target))) return;
  closeMenu();
}

function onViewportChange(event: Event) {
  if (isScrollInsideElement(event, listEl.value)) return;
  closeMenu();
}

function bindListeners() {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
}

function unbindListeners() {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
}

watch(open, (isOpen) => {
  if (isOpen) bindListeners();
  else {
    menuPlaced.value = false;
    unbindListeners();
  }
});
watch(() => props.modelValue, (value) => { activeId.value = value; });
watch(activeId, () => {
  if (open.value) void nextTick(revealActiveChoice);
});
onBeforeUnmount(unbindListeners);
</script>

<template>
  <div ref="triggerEl" class="win-choice" @focusout="onFocusOut">
    <WinButton
      class="win-choice-trigger"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listboxId : undefined"
      @Click="toggleMenu"
      @keydown="onTriggerKeydown"
    >
      <span class="win-choice-label">{{ selectedChoice?.label }}</span>
      <Icon class="win-choice-chevron" name="chevronDown" :size="14" />
    </WinButton>
    <Teleport to="body">
      <div
        v-if="open"
        :id="listboxId"
        ref="listEl"
        class="win-choice-flyout"
        :class="`open-${menuPlacement.placement}`"
        :style="menuStyle"
        role="listbox"
        tabindex="-1"
        :aria-label="ariaLabel"
        :aria-activedescendant="activeDescendant"
        @keydown="onListKeydown"
        @focusout="onFocusOut"
      >
        <div
          v-for="choice in choices"
          :id="optionDomId(choice.id)"
          :key="choice.id"
          class="win-choice-option"
          :class="{ active: activeId === choice.id, selected: modelValue === choice.id, disabled: choice.disabled }"
          role="option"
          :aria-selected="modelValue === choice.id"
          :aria-disabled="choice.disabled || undefined"
          @mousemove="!choice.disabled && (activeId = choice.id)"
          @click="selectChoice(choice)"
        >
          <span>{{ choice.label }}</span>
          <Icon v-if="modelValue === choice.id" name="check" :size="15" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.win-choice { width: min(180px, 100%); min-width: 110px; }
.win-choice :deep(.win-choice-trigger) {
  width: 100%; height: 32px; min-height: 32px; padding: 0 10px 0 12px;
  border-radius: 4px; border-color: var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
  color: var(--color-text-primary); font-size: var(--fs-sm); text-align: left;
}
.win-choice :deep(.win-choice-trigger:hover), .win-choice :deep(.win-choice-trigger:focus-visible) {
  border-color: var(--color-accent-primary); color: var(--color-text-primary);
}
.win-choice :deep(.win-choice-trigger:focus-visible) { outline: 2px solid color-mix(in srgb, var(--color-accent-primary) 70%, transparent); outline-offset: 2px; }
.win-choice-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.win-choice-chevron { margin-left: 8px; color: var(--color-text-muted); }
.win-choice-flyout {
  position: fixed; z-index: 1400; overflow-y: auto; padding: 4px;
  border: 1px solid var(--color-border-subtle); border-radius: 8px;
  background: color-mix(in srgb, var(--color-bg-elevated) 94%, transparent);
  box-shadow: 0 12px 32px rgb(0 0 0 / 32%); backdrop-filter: blur(20px);
}
.win-choice-flyout:focus-visible { outline: 2px solid var(--color-accent-primary); outline-offset: 2px; }
.win-choice-option {
  display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 8px; border-radius: 4px; color: var(--color-text-secondary); cursor: pointer; font-size: var(--fs-sm);
}
.win-choice-option.active, .win-choice-option:hover { background: color-mix(in srgb, var(--color-accent-primary) 18%, transparent); color: var(--color-text-primary); }
.win-choice-option.selected { font-weight: 600; }
.win-choice-option.disabled { cursor: default; opacity: 0.45; }
@media (max-width: 768px) { .win-choice { width: min(140px, 100%); } }
</style>
