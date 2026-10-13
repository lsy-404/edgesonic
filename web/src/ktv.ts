// SPDX-License-Identifier: AGPL-3.0-or-later
import { createApp } from "vue";
import { i18n } from "./i18n";
import "./theme";
import "./assets/palette.css";
import "./assets/decor.css";
import "@platform-kit/fluent/style.css";
import "./assets/fluent.css";
import KtvJoin from "./views/KtvJoin.vue";

document.title = `${i18n.global.t("pageTitles.Join Karaoke")} · EdgeSonic`;
createApp(KtvJoin).use(i18n).mount("#app");
