<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";

interface NavigationItem {
  label: string;
  path: string;
  icon: string;
}
interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}
const props = defineProps<{ groups: NavigationGroup[] }>();
const emit = defineEmits<{ navigate: [] }>();
const { t } = useI18n();
const route = useRoute();
const moreOpen = ref(false);
const moreButton = ref<HTMLButtonElement | null>(null);
const morePanel = ref<HTMLDialogElement | null>(null);
const primaryPaths = ["/", "/library", "/starred", "/playlists"];
const primaryItems = computed(() =>
  primaryPaths.flatMap((path) =>
    props.groups
      .flatMap((group) => group.items)
      .filter((item) => item.path === path),
  ),
);
const moreGroups = computed(() =>
  props.groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !primaryPaths.includes(item.path)),
    }))
    .filter((group) => group.items.length),
);
const moreActive = computed(() => !primaryPaths.includes(route.path));

function showMore(element: Element) {
  (element as HTMLDialogElement).showModal();
}
function finishClose(element: Element) {
  (element as HTMLDialogElement).close();
  moreButton.value?.focus({ preventScroll: true });
}
function dismissBackdrop(event: MouseEvent) {
  if (event.target !== event.currentTarget) return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (
    event.clientY < bounds.top ||
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY > bounds.bottom
  )
    moreOpen.value = false;
}
const mobileQuery = window.matchMedia("(max-width: 960px)");
function onViewportChange(event: MediaQueryListEvent) {
  if (!event.matches) moreOpen.value = false;
}
mobileQuery.addEventListener("change", onViewportChange);
watch(
  () => route.fullPath,
  () => {
    moreOpen.value = false;
  },
);
onBeforeUnmount(() => {
  morePanel.value?.close();
  mobileQuery.removeEventListener("change", onViewportChange);
});
</script>

<template>
  <nav class="mobile-navigation" :aria-label="t('app.primaryNavigation')">
    <router-link
      v-for="item in primaryItems"
      :key="item.path"
      :to="item.path"
      class="mobile-nav-item"
      :class="{ active: route.path === item.path }"
      :aria-current="route.path === item.path ? 'page' : undefined"
      @click="emit('navigate')"
    >
      <Icon :name="item.icon" :size="21" />
      <span>{{ item.label }}</span>
    </router-link>
    <button
      ref="moreButton"
      type="button"
      class="mobile-nav-item"
      :class="{ active: moreActive || moreOpen }"
      aria-haspopup="dialog"
      :aria-expanded="moreOpen"
      aria-controls="mobile-more-navigation"
      @click="moreOpen = true"
    >
      <Icon name="menu" :size="21" />
      <span>{{ t("app.more") }}</span>
    </button>
  </nav>

  <Teleport to="body">
    <Transition
      name="navigation-sheet"
      @enter="showMore"
      @after-leave="finishClose"
    >
      <dialog
        v-if="moreOpen"
        id="mobile-more-navigation"
        ref="morePanel"
        class="mobile-more-panel"
        aria-labelledby="mobile-more-title"
        @cancel.prevent="moreOpen = false"
        @click="dismissBackdrop"
      >
        <header class="mobile-more-header">
          <h2 id="mobile-more-title">{{ t("app.more") }}</h2>
          <button
            class="icon-button"
            type="button"
            :aria-label="t('common.close')"
            autofocus
            @click="moreOpen = false"
          >
            <Icon name="cross" :size="20" />
          </button>
        </header>
        <section
          v-for="group in moreGroups"
          :key="group.label"
          class="mobile-more-group"
        >
          <h3>{{ group.label }}</h3>
          <router-link
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="mobile-more-link"
            :class="{ active: route.path === item.path }"
            :aria-current="route.path === item.path ? 'page' : undefined"
            @click="
              moreOpen = false;
              emit('navigate');
            "
          >
            <Icon :name="item.icon" :size="20" />
            <span>{{ item.label }}</span>
            <Icon name="right" :size="16" />
          </router-link>
        </section>
      </dialog>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mobile-navigation {
  display: none;
}
.mobile-more-panel {
  position: fixed;
  inset: auto 0 0;
  box-sizing: border-box;
  width: min(100%, 540px);
  max-width: 100%;
  max-height: calc(100dvh - var(--nav-h) - 24px);
  margin: 0 auto;
  padding: 16px 20px calc(20px + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--color-border-default);
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  box-shadow: 0 -8px 48px rgb(0 0 0 / 24%);
}
.mobile-more-panel::backdrop {
  background: var(--color-bg-overlay);
}
.mobile-more-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.mobile-more-header h2 {
  font: 600 20px/1.5 var(--font-body);
  margin: 0;
}
.mobile-more-group {
  margin-top: 20px;
}
.mobile-more-group h3 {
  margin: 0 0 6px;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 600;
}
.mobile-more-link {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 48px;
  padding: 8px 12px;
  border-radius: 4px;
  color: var(--color-text-secondary);
  text-decoration: none;
}
.mobile-more-link span {
  flex: 1;
}
.mobile-more-link:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}
.mobile-more-link.active {
  background: var(--color-accent-dim);
  color: var(--color-accent-primary);
}
.navigation-sheet-enter-active {
  transition:
    transform 280ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 220ms ease;
}
.navigation-sheet-leave-active {
  transition:
    transform 200ms cubic-bezier(0.4, 0, 1, 1),
    opacity 160ms ease;
}
.navigation-sheet-enter-from,
.navigation-sheet-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
@media (max-width: 960px) {
  .mobile-navigation {
    position: fixed;
    inset: auto 0 0;
    z-index: 210;
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    height: var(--bottom-nav-space);
    box-sizing: border-box;
    padding: 4px 8px max(4px, env(safe-area-inset-bottom, 0px));
    background: color-mix(in srgb, var(--color-bg-secondary) 94%, transparent);
    backdrop-filter: blur(24px) saturate(150%);
    border-top: 1px solid var(--color-border-subtle);
  }
  .mobile-nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 0;
    min-height: 48px;
    padding: 4px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-secondary);
    text-decoration: none;
    font: 500 11px/1.2 var(--font-body);
    cursor: pointer;
  }
  .mobile-nav-item span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-nav-item.active {
    color: var(--color-accent-primary);
    background: var(--color-accent-dim);
  }
  .mobile-nav-item:hover {
    background: var(--color-bg-tertiary);
  }
  .mobile-nav-item:focus-visible,
  .mobile-more-link:focus-visible {
    outline: 2px solid var(--color-accent-primary);
    outline-offset: -2px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .navigation-sheet-enter-active,
  .navigation-sheet-leave-active {
    transition-duration: 1ms;
  }
}
</style>
