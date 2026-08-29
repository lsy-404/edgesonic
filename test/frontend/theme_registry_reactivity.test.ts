import { defineComponent, isReactive } from "vue";
import { getTheme, registerTheme } from "../../web/src/themes/registry";

let failures = 0;
const assert = (ok: unknown, message: string) => {
  if (ok) console.log(`  ✓ ${message}`);
  else {
    failures++;
    console.error(`  ✗ ${message}`);
  }
};

const progressThumb = defineComponent({ template: "<span />" });
registerTheme({ id: "test-non-reactive-components", progressThumb });

console.log("theme registry reactivity:");
assert(getTheme("test-non-reactive-components")?.progressThumb === progressThumb, "preserves component identity");
assert(!isReactive(getTheme("test-non-reactive-components")?.progressThumb), "does not make theme components reactive");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
