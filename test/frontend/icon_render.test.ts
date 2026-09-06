import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import Icon from "../../web/src/components/Icon.vue";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function render(name: string, props: Record<string, string | number> = {}): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(Icon, { name, ...props }) }));
}

async function main() {
  const names = [
    "album", "ban", "bell", "check", "chevronDown", "chevronUp", "clock", "close", "copy", "cross",
    "dashboard", "dot", "dots", "down", "download", "edit", "empty", "flag", "folder", "gear", "headphones",
    "heart", "help", "home", "info", "left", "library", "lock", "logout", "maximize", "menu", "minimize",
    "music", "next", "note", "pause", "playlist", "play", "plus", "podcast", "previous", "queueNext", "radio",
    "refresh", "repeat", "repeatOne", "right", "search", "settings", "share", "shuffle", "star", "tools", "trending",
    "up", "upload", "users", "volume", "volumeOff", "warn",
  ];

  console.log("every declared icon renders an SVG:");
  for (const name of names) {
    const html = await render(name);
    assert(html.includes("<svg"), `${name} renders an SVG`);
  }

  console.log("the library maps names to distinct Lucide glyphs:");
  const home = await render("home");
  const library = await render("library");
  const unknown = await render("no-such-icon");
  assert(home.includes("lucide-house"), "home maps to House");
  assert(library.includes("lucide-library"), "library maps to Library");
  assert(unknown.includes("lucide-circle"), "unknown names use the Circle fallback");

  console.log("size and accessibility props survive rendering:");
  const numericString = await render("home", { size: "16", label: "Home" });
  const cssSize = await render("home", { size: "1.25rem" });
  assert(numericString.includes("width:16px") && numericString.includes("height:16px"), "numeric strings become pixel dimensions");
  assert(cssSize.includes("width:1.25rem") && cssSize.includes("height:1.25rem"), "CSS dimensions remain unchanged");
  assert(numericString.includes('role="img"') && numericString.includes('aria-label="Home"'), "label exposes an accessible image");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error("UNCAUGHT", error); process.exit(2); });
