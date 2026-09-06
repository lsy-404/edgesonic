<script setup lang="ts">
import {
  Album, ArrowDown, ArrowUp, Ban, Bell, Check, ChevronDown, ChevronLeft, ChevronRight,
  ChevronUp, Circle, CircleHelp, Clock, Cog, Copy, Download, Flag, Folder, Headphones,
  Heart, House, Info, LayoutDashboard, Library, ListMusic, ListPlus, Lock, LogOut,
  Maximize2, Menu, Minimize2, MoreHorizontal, Music, Music2, Pause, Pencil, Play, Plus,
  Podcast, Radio, RefreshCw, Repeat, Repeat1, Search, Settings, Share2, Shuffle, SkipBack,
  SkipForward, Star, TriangleAlert, TrendingUp, Upload, Users, Volume2, VolumeX, Wrench, X,
} from "@lucide/vue";
import { computed } from "vue";

const props = defineProps<{ name: string; size?: string | number; label?: string }>();

const icons = {
  album: Album, ban: Ban, bell: Bell, check: Check, chevronDown: ChevronDown,
  chevronUp: ChevronUp, clock: Clock, close: X, copy: Copy, cross: X, dashboard: LayoutDashboard,
  dot: Circle, dots: MoreHorizontal, down: ArrowDown, download: Download, edit: Pencil,
  empty: Circle, flag: Flag, folder: Folder, gear: Cog, headphones: Headphones, heart: Heart,
  help: CircleHelp, home: House, info: Info, left: ChevronLeft, library: Library, lock: Lock,
  logout: LogOut, maximize: Maximize2, menu: Menu, minimize: Minimize2, music: Music,
  next: SkipForward, note: Music2, pause: Pause, playlist: ListMusic, play: Play, plus: Plus,
  podcast: Podcast, previous: SkipBack, queueNext: ListPlus, radio: Radio, refresh: RefreshCw,
  repeat: Repeat, repeatOne: Repeat1, right: ChevronRight, search: Search, settings: Settings,
  share: Share2, shuffle: Shuffle, star: Star, tools: Wrench, trending: TrendingUp, up: ArrowUp,
  upload: Upload, users: Users, volume: Volume2, volumeOff: VolumeX, warn: TriangleAlert,
} as const;

const icon = computed(() => icons[props.name as keyof typeof icons] ?? Circle);
const numericSize = computed(() => typeof props.size === "number" ? props.size : undefined);
const iconStyle = computed(() => {
  const size = props.size === undefined ? "1em" : typeof props.size === "number" ? `${props.size}px` : props.size;
  return { width: size, height: size };
});
</script>

<template>
  <component
    :is="icon"
    class="es-icon"
    :class="`es-icon-${name}`"
    :size="numericSize"
    :style="iconStyle"
    :stroke-width="1.75"
    :role="label ? 'img' : 'presentation'"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
.es-icon { display: inline-block; flex-shrink: 0; vertical-align: middle; }
</style>
