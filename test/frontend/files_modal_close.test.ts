// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// The file browser's modals close on success. Each of them guards its closer
// with "refuse while busy" so a backdrop click can't yank the dialog away
// mid-operation — but the confirm handlers ran that same guarded closer while
// their own busy flag was still set, so the guard swallowed it: the operation
// succeeded and the dialog just sat there, reading as a dead button.
//
// Run: npx tsx test/frontend/files_modal_close.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const SRC = readFileSync(
  join(__dirname, "..", "..", "web", "src", "views", "Files.vue"),
  "utf8",
);

function body(name: string): string {
  return SRC.match(new RegExp(`(async )?function ${name}\\([\\s\\S]*?\\n}`))?.[0] ?? "";
}

const MODALS = [
  { what: "new folder", confirm: "confirmNewFolder", close: "closeNewFolderModal", reset: "resetNewFolderModal", busy: "newFolderBusy" },
  { what: "move/copy", confirm: "confirmOp", close: "closeOpModal", reset: "resetOpModal", busy: "opBusy" },
  { what: "cross-source copy", confirm: "confirmCrossOp", close: "closeCrossModal", reset: "resetCrossModal", busy: "crossCopyBusy" },
];

for (const m of MODALS) {
  console.log(`${m.what}:`);
  const confirm = body(m.confirm);
  const close = body(m.close);
  const reset = body(m.reset);

  assert(confirm.length > 0 && close.length > 0 && reset.length > 0, "confirm / close / reset all exist");
  // The guard is what protects a backdrop click mid-flight; keep it.
  assert(
    new RegExp(`if \\(${m.busy}\\.value\\) return;`).test(close),
    "the dismiss path still refuses while the operation is in flight",
  );
  assert(!new RegExp(`${m.busy}\\.value`).test(reset), "the reset path carries no busy guard");
  // …and the success path must not go through it, or it closes nothing.
  assert(
    !new RegExp(`\\b${m.close}\\(`).test(confirm),
    "the success path does not call the guarded closer",
  );
  assert(new RegExp(`\\b${m.reset}\\(`).test(confirm), "the success path resets the modal directly");
  // The busy flag is only cleared in finally, i.e. after the close would run.
  assert(
    new RegExp(`finally[\\s\\S]*${m.busy}\\.value = false`).test(confirm),
    "the busy flag is still set when the success path closes (which is why the guard swallowed it)",
  );
}

console.log("cancel and backdrop keep the guard:");
{
  for (const m of MODALS) {
    assert(
      new RegExp(`@click\\.self="${m.close}"`).test(SRC),
      `${m.what}: backdrop click goes through the guarded closer`,
    );
  }
  // Delete never had the bug — it clears its own ref — but the guarded cancel
  // still has to be wired to the button.
  assert(/@click\.self="cancelDeleteConfirm"/.test(SRC), "delete confirm keeps its guarded cancel");
  assert(
    /deleteConfirmModal\.value = null;/.test(body("confirmDelete")),
    "delete's success path clears its own ref rather than calling the guarded cancel",
  );
}

console.log("the move/copy destination picker renders what it fetched:")
{
  // destTreeRoot is a ref: reading .value hands back a reactive proxy, and
  // only writes through that proxy notify the template. Loading the children
  // into the object literal instead left the picker showing a lone root row,
  // so the only reachable destination was the directory already open.
  const init = body("initDestTree");
  assert(init.length > 0, "initDestTree exists");
  assert(
    /let node = destTreeRoot\.value;/.test(init),
    "the walk starts from the ref's proxy",
  );
  assert(
    !/loadDestChildren\(root\)/.test(init),
    "children are not loaded into the raw object literal",
  );
  assert(
    /destTreeRoot\.value = root;[\s\S]*?loadDestChildren\(node\)/.test(init),
    "the fetch happens after the ref has taken ownership of the node",
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
