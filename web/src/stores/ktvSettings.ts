// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineStore } from "pinia";
import { ref } from "vue";
import { fetchKtvSettings, saveKtvSettings, type KtvSettings } from "../lib/ktvApi";

export const useKtvSettingsStore = defineStore("ktvSettings", () => {
  const enabled = ref(false);
  const mode = ref<KtvSettings["mode"]>("fair");
  const loaded = ref(false);
  const busy = ref(false);
  const error = ref("");

  async function load() {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      const data = await fetchKtvSettings();
      enabled.value = data.enabled;
      mode.value = data.mode;
      loaded.value = true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "KTV settings are unavailable.";
    } finally { busy.value = false; }
  }

  async function save(next: Partial<KtvSettings>) {
    busy.value = true;
    error.value = "";
    try {
      const data = await saveKtvSettings(next);
      enabled.value = data.enabled;
      mode.value = data.mode;
      loaded.value = true;
      return true;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "KTV settings could not be saved.";
      return false;
    } finally { busy.value = false; }
  }

  return { enabled, mode, loaded, busy, error, load, save };
});
