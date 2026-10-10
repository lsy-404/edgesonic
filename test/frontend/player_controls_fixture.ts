import { createApp, h, ref } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { FluentTheme, FluentSwitch } from '@platform-kit/fluent/vue';
import Library from '../../web/src/views/Library.vue';
import { useDetailStore } from '../../web/src/stores/detail';
import PlayerBar from '../../web/src/components/PlayerBar.vue';
import ListOptionsMenu from '../../web/src/components/ListOptionsMenu.vue';
import StarButton from '../../web/src/components/StarButton.vue';
import { i18n } from '../../web/src/i18n';
import { setTheme } from '../../web/src/theme';
import { ensureBuiltinThemeLoaded } from '../../web/src/themes/builtin';
import { usePlayerStore } from '../../web/src/stores/player';
import '../../web/src/assets/palette.css';
import '../../web/src/assets/decor.css';
import '../../web/src/assets/fluent.css';
sessionStorage.setItem('edgesonic:playMode', 'sequential');
const pinia = createPinia();
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] });
const showLibrary = new URLSearchParams(location.search).has('library');
const starred = ref(false);
const menuOpen = ref(false);
const hideInstrumental = ref(false);
createApp({
  render: () => h(FluentTheme, { mode: 'dark', class: 'edgesonic-fluent-theme' }, {
    default: () => [
      h(PlayerBar),
      h(StarButton, { id: 'test', kind: 'song', starred: starred.value, 'onUpdate:starred': (value: boolean) => { starred.value = value; } }),
      ...(showLibrary ? [h('main', { class: 'main', style: { height: 'calc(100dvh - var(--player-h, 96px) - 32px)', overflowY: 'auto' } }, [
        h('section', { id: 'library-main' }, [h(Library)]),
        h('section', { id: 'library-starred' }, [h(Library, { starredOnly: true })]),
        h('section', { id: 'library-detail' }, [h(Library, { embedded: true, detailTarget: { kind: 'album', id: 'test-album' } })]),
      ])] : []),
      h(ListOptionsMenu, {
        open: menuOpen.value,
        hideInstrumental: hideInstrumental.value,
        onToggle: () => { menuOpen.value = !menuOpen.value; },
        onClose: () => { menuOpen.value = false; },
        'onUpdate:hideInstrumental': (value: boolean) => { hideInstrumental.value = value; },
      }),
    ],
  }),
}).use(pinia).use(router).use(i18n).component('FluentSwitch', FluentSwitch).mount('#app');
Object.assign(window, {
  async setTheme(theme: string) { setTheme(theme); await ensureBuiltinThemeLoaded(theme); },
  setStarred(value: boolean) { starred.value = value; },
  player: usePlayerStore(pinia),
  detail: useDetailStore(pinia),
});
const player = usePlayerStore(pinia);
player.queue = [{ id: 'test', title: 'Test track', duration: 120 }];
player.index = 0;
player.duration = 120;
player.currentTime = 60;
