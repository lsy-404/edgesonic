import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const app = read("web/src/App.vue");
const library = read("web/src/views/Library.vue");
const main = read("web/src/main.ts");
const en = read("web/src/locales/en.json");
const zh = read("web/src/locales/zh-CN.json");

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures++;
    console.error(`  ✗ ${message}`);
  }
}

console.log("global search reliability:");
assert(app.includes('role="search"'), "top bar exposes a search form");
assert(app.includes('path: "/library", query: { q }'), "top bar submits a query to Library");
assert(app.includes("onGlobalSearchShortcut") && app.includes("event.key.toLowerCase() === \"k\""), "Cmd/Ctrl+K focuses global search");
assert(app.includes('@keydown.enter.prevent="submitGlobalSearch"'), "Enter submits the global search form");
assert(app.includes('@keydown.esc.prevent="clearGlobalSearch"'), "Escape clears the global search field");
assert(library.includes("watch(() => route.query.q"), "Library restores queries from route state");
assert(library.includes("updateSearchRoute(query, lyricQuery)"), "Library writes both search conditions back to the route atomically");
assert(library.includes("let searchRequest = 0") && library.includes("if (request !== searchRequest) return;"), "stale search responses are discarded");
assert(library.includes("const searchError = ref(\"\")") && library.includes('t("library.searchFailed")'), "search failures have a distinct state");
assert(library.includes('class="btn-secondary btn-sm" @click="retrySearch"'), "search failures can be retried");
assert(library.includes("let detailRequest = 0") && library.includes("if (request !== detailRequest) return;"), "stale artist and album detail responses are discarded");
assert(main.includes("router.afterEach((to) => syncDocumentTitle(to.meta.title))"), "route navigation updates document title");
assert(en.includes('"globalSearch"') && zh.includes('"globalSearch"'), "global search copy is localized in English and Chinese");
assert(en.includes('"searchFailed"') && zh.includes('"searchFailed"'), "search failure copy is localized in English and Chinese");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
