import { isOutsideElements } from "../../web/src/lib/outsideClick";
import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function element(name: string, children: unknown[] = []) {
  return {
    name,
    contains: (target: unknown) => target === name || children.includes(target),
  } as unknown as HTMLElement;
}

const panel = element("panel", ["queue-item", "remove-button"]);
const button = element("button", ["count"]);

assert(!isOutsideElements("queue-item" as unknown as EventTarget, [panel, button]), "queue rows are treated as inside clicks");
assert(!isOutsideElements("remove-button" as unknown as EventTarget, [panel, button]), "queue row controls are treated as inside clicks");
assert(!isOutsideElements("button" as unknown as EventTarget, [panel, button]), "the queue trigger remains an inside click");
assert(!isOutsideElements("count" as unknown as EventTarget, [panel, button]), "trigger descendants remain inside clicks");
assert(isOutsideElements("page" as unknown as EventTarget, [panel, button]), "page content outside the queue closes it");
assert(isOutsideElements(null, [panel, button]), "missing event targets are outside by default");

const source = fs.readFileSync(
  path.join(__dirname, "..", "..", "web", "src", "components", "PlayerBar.vue"),
  "utf8",
);

assert(source.includes("document.addEventListener(\"pointerdown\", onDocumentPointerDown)"), "player listens for document pointerdown while mounted");
assert(source.includes("document.removeEventListener(\"pointerdown\", onDocumentPointerDown)"), "player removes the document pointerdown listener");
assert(source.includes("isOutsideElements(e.target, [queuePanel.value, queueButton.value])"), "outside-click boundary includes both queue panel and trigger button");
assert(source.includes('ref="queueButton"'), "queue trigger exposes a template ref for the boundary check");
assert(source.includes('ref="queuePanel"'), "queue panel exposes a template ref for the boundary check");
assert(source.includes('@click="queueOpen = !queueOpen"'), "queue trigger still toggles the panel");
assert(source.includes('@click.stop="removeFromQueue(i)"'), "queue internal remove actions still stop row playback clicks");

process.exit(failures ? 1 : 0);
