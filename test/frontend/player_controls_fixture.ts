import { createApp, h, ref } from 'vue';
import { createPinia } from 'pinia';
import { FluentTheme, FluentSwitch } from '@lsypkg/fluent/vue';
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
const pinia = createPinia();
const starred = ref(false);
const menuOpen = ref(false);
const hideInstrumental = ref(false);
createApp({
  render: () => h(FluentTheme, { mode: 'dark', class: 'edgesonic-fluent-theme' }, {
    default: () => [
      h(PlayerBar),
      h(StarButton, { id: 'test', kind: 'song', starred: starred.value }),
      h(ListOptionsMenu, {
        open: menuOpen.value,
        hideInstrumental: hideInstrumental.value,
        onToggle: () => { menuOpen.value = !menuOpen.value; },
        onClose: () => { menuOpen.value = false; },
        'onUpdate:hideInstrumental': (value: boolean) => { hideInstrumental.value = value; },
      }),
    ],
  }),
}).use(pinia).use(i18n).component('FluentSwitch', FluentSwitch).mount('#app');
Object.assign(window, {
  async setTheme(theme: string) { setTheme(theme); await ensureBuiltinThemeLoaded(theme); },
  setStarred(value: boolean) { starred.value = value; },
  player: usePlayerStore(pinia),
});
const player = usePlayerStore(pinia);
player.queue = [{ id: 'test', title: 'Test track', duration: 120 }];
player.index = 0;
player.duration = 120;
player.currentTime = 60;
