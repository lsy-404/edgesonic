import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/components/BudgetedImage.vue"), "utf8");
assert(source.includes("runLowPriority((signal) => loadImage(signal))"), "images receive the budget cancellation signal");
assert(source.includes('image.src = ""'), "cancellation clears the image source");
assert(source.includes("onBeforeUnmount(() =>") && source.includes("releaseLoad?.()"), "unmount invokes the active image cancellation path");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
