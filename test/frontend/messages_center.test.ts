// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run: npx tsx test/frontend/messages_center.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const root = join(__dirname, "..", "..");
const component = readFileSync(join(root, "web/src/components/MessageCenter.vue"), "utf8");
const api = readFileSync(join(root, "web/src/api.ts"), "utf8");
const app = readFileSync(join(root, "web/src/App.vue"), "utf8");
const english = readFileSync(join(root, "web/src/locales/en.json"), "utf8");
const chinese = readFileSync(join(root, "web/src/locales/zh-CN.json"), "utf8");

console.log("message API:");
assert(/edgesonicFetch\("messages"\)/.test(api), "loads the current account message feed");
assert(/edgesonicPost\("messages\/read", \{ id \}\)/.test(api), "marks individual messages read");
assert(/edgesonicPost\("messages\/dismiss", \{ id \}\)/.test(api), "dismisses individual messages");
assert(/edgesonicPost\("messages\/send", input\)/.test(api), "sends administrator messages");

console.log("visibility and priority:");
assert(/props\.isSuperAdmin \? officialMessages\.value : \[\]/.test(component), "official messages are client-filtered to super administrators");
assert(/!message\.readAt && message\.presentation === "modal"/.test(component), "only unread modal-presentation messages interrupt with a dialog");
assert(/setInterval\(\(\) => \{ void refresh\(\); \}, 60_000\)/.test(component), "refreshes messages while the account is online");
assert(/bodyHtml:\s*string/.test(api), "models the Worker-provided sanitized HTML message body");
assert(/v-html="message\.bodyHtml"/.test(component), "renders only the Worker-provided sanitized message HTML");
assert(!/v-html="message\.body"/.test(component), "never treats the raw Markdown body as HTML");
assert(!/message-center-backdrop[^\n]*@click\.self="panelOpen/.test(component), "the ordinary message center does not use a blocking backdrop");
assert(/class="message-center-panel"[\s\S]*role="region"/.test(component), "uses a non-modal side-panel region for ordinary messages");
assert(/activeView === 'compose'/.test(component), "keeps the administrator composer in its own panel view");

console.log("app integration:");
assert(/import MessageCenter from "\.\/components\/MessageCenter\.vue"/.test(app), "loads the message center into the app shell");
assert(/<MessageCenter :is-super-admin="level >= 3"/.test(app), "passes super-administrator status to the center");
assert(/:can-manage-users="hasPerm\('manage_users'\)"/.test(app), "passes administrator send permission to the center");
assert(/"messages"\s*:/.test(english) && /"messages"\s*:/.test(chinese), "includes both localized message-center labels");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
