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
// The file browser's context menu and folder rename. There is no DOM shim in
// this repo (the other .vue suites render through Vue's SSR path, which never
// dispatches events), so the wiring is checked against the source the same way
// library_songs_default_tab.test.ts does: the handlers, the listener
// symmetry and the request shape are the contract.
//
// Run: npx tsx test/frontend/files_context_menu.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const ROOT = join(__dirname, "..", "..");
const SRC = readFileSync(join(ROOT, "web", "src", "views", "Files.vue"), "utf8");

console.log("right-click reaches every part of the list:");
{
  assert(
    /class="entry-list"[^>]*@contextmenu="onRowContextMenu\(\$event, \{ kind: 'blank' \}\)"/.test(SRC),
    "blank list area opens the directory menu",
  );
  assert(
    /@contextmenu="onRowContextMenu\(\$event, \{ kind: 'dir', dir: d \}\)"/.test(SRC),
    "folder rows open a folder menu",
  );
  assert(
    /@contextmenu="onRowContextMenu\(\$event, \{ kind: 'file', file: f \}\)"/.test(SRC),
    "file rows open a file menu",
  );
  // preventDefault is what actually replaces the browser's own menu.
  const handler = SRC.match(/function onRowContextMenu\([\s\S]*?\n}/)?.[0] ?? "";
  assert(/e\.preventDefault\(\)/.test(handler), "the native menu is suppressed");
  assert(/e\.stopPropagation\(\)/.test(handler), "a row menu doesn't also fire the blank-area menu");
}

console.log("the row carries one trigger instead of a strip:");
{
  // The per-action icon buttons moved into the menu; a row now shows a single
  // ⋯ button, and folders — which had no visible entry point at all — get one
  // too.
  const rows = SRC.match(/<div class="entry-list"[\s\S]*?<div v-if="!dirs\.length/)?.[0] ?? "";
  assert(rows.length > 0, "the entry list block is present");
  assert(
    /openRowMenu\(\$event, \{ kind: 'file', file: f \}\)/.test(rows),
    "file rows open the menu from their trigger",
  );
  assert(
    /openRowMenu\(\$event, \{ kind: 'dir', dir: d \}\)/.test(rows),
    "folder rows open the menu from their trigger",
  );
  for (const gone of ["op-edit-tag", "op-cross", "op-rename", "op-move", "op-copy", "op-delete"]) {
    assert(!rows.includes(gone), `the ${gone} button is no longer inline`);
  }
  // Confirm/cancel stay inline — they belong to the rename editor, not the
  // action set.
  assert(/op-confirm/.test(rows) && /op-cancel/.test(rows), "the rename editor keeps its own buttons");
  // A second press on the same trigger closes rather than reopening.
  const open = SRC.match(/function openRowMenu\([\s\S]*?\n}/)?.[0] ?? "";
  assert(/ctxTargetKey\(ctxMenu\.value\.target\) === ctxTargetKey\(target\)/.test(open), "the trigger toggles");
  assert(/closeContextMenu\(\);\n    return;/.test(open), "…by closing on the second press");
  assert(/getBoundingClientRect\(\)/.test(open), "the menu is anchored under the trigger");
}

console.log("renaming puts the caret in the box:");
{
  const focus = SRC.match(/async function focusRenameInput\([\s\S]*?\n}/)?.[0] ?? "";
  assert(focus.length > 0, "focusRenameInput exists");
  assert(/await nextTick\(\)/.test(focus), "it waits for the input to render");
  assert(/\.focus\(\)/.test(focus), "it focuses the input");
  // A file's suffix stays out of the selection so typing can't silently drop
  // the extension; a folder has none, so it selects the whole name.
  assert(/lastIndexOf\("\."\)/.test(focus) && /setSelectionRange\(0, dot\)/.test(focus), "a file's suffix is left out of the selection");
  assert(/el\.select\(\)/.test(focus), "a folder selects the whole name");
  assert(/function startRename\([\s\S]*?focusRenameInput\(true\)/.test(SRC), "renaming a file focuses and keeps the suffix");
  assert(/function startRenameDir\([\s\S]*?focusRenameInput\(false\)/.test(SRC), "renaming a folder focuses and selects it all");
  // The old markup leaned on the autofocus attribute, which browsers only
  // honour on the initial parse, not on a node Vue inserts later. Comments
  // are stripped first — they explain the attribute rather than use it.
  const code = SRC.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(!/\bautofocus\b/.test(code), "no leftover autofocus attribute");
  // The new-folder dialog had the same dead attribute.
  assert(
    /function openNewFolderModal\([\s\S]*?nextTick\([\s\S]*?new-folder-input[\s\S]*?focus\(\)/.test(SRC),
    "the new folder dialog focuses its input too",
  );
}

console.log("the menu escapes the page it sits in:");
{
  assert(/<Teleport to="body">/.test(SRC), "menu is teleported to <body>");
  assert(/class="ctx-menu"/.test(SRC) && /\.ctx-menu \{[\s\S]*?position: fixed/.test(SRC), "menu is position:fixed");
  // Modals are z-index 1000 (assets/palette.css); the menu must stay under them.
  const z = Number(SRC.match(/\.ctx-menu \{[\s\S]*?z-index: (\d+)/)?.[1] ?? "0");
  assert(z > 0 && z < 1000, `menu z-index (${z}) sits below the modals`);
  // Opened at a click point near the right/bottom edge the menu has to be
  // pulled back into the viewport, which needs its measured size.
  const open = SRC.match(/async function openContextMenu\([\s\S]*?\n}/)?.[0] ?? "";
  assert(/await nextTick\(\)/.test(open), "placement waits for the menu to render");
  assert(/getBoundingClientRect\(\)/.test(open), "placement measures the rendered menu");
  assert(/placeFloatingPoint\(x, y, el\.getBoundingClientRect\(\)/.test(open), "placement uses the shared viewport placer");
  assert(/menu\.maxHeight = placement\.maxHeight/.test(open), "placement carries usable height into the menu");
  assert(/\.ctx-menu \{[\s\S]*?overflow-y: auto/.test(SRC), "overflowing menus scroll inside their usable height");
}

console.log("every listener the menu adds is taken back:");
{
  const open = SRC.match(/async function openContextMenu\([\s\S]*?\n}/)?.[0] ?? "";
  const close = SRC.match(/function closeContextMenu\(event\?: Event\)[\s\S]*?\n}/)?.[0] ?? "";
  const added = [...open.matchAll(/(document|window)\.addEventListener\("(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  const removed = [...close.matchAll(/(document|window)\.removeEventListener\("(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert(added.length >= 4, `open registers the outside-click/keyboard/scroll listeners (${added.length})`);
  assert(
    added.every((name) => removed.includes(name)),
    `close removes all of them (added ${added.join(", ")} / removed ${removed.join(", ")})`,
  );
  // A capture-phase scroll listener has to be removed with the same flag or it
  // leaks past the component.
  assert(
    /removeEventListener\("scroll", closeContextMenu, true\)/.test(close),
    "the capturing scroll listener is removed with capture: true",
  );
  assert(
    /isScrollInsideElement\(event, ctxMenuEl\.value\)/.test(close),
    "scrolling inside the menu does not dismiss it",
  );
  assert(/onBeforeUnmount\(\(\) => \{[\s\S]*?closeContextMenu\(\)/.test(SRC), "unmount closes the menu");
  assert(/onBeforeUnmount\(\(\) => \{[\s\S]*?cancelLongPress\(\)/.test(SRC), "unmount clears a pending long-press timer");
  assert(/if \(e\.key === "Escape"\) \{ closeContextMenu\(\)/.test(SRC), "Escape closes the menu");
  // Menu items read ctxFile/ctxDir, which closeContextMenu() nulls out. Closing
  // first made every item call its handler with null and throw.
  const run = SRC.match(/function ctxRun\([\s\S]*?\n}/)?.[0] ?? "";
  assert(
    run.indexOf("action()") < run.indexOf("closeContextMenu()"),
    "the item's action runs before the menu is dismissed",
  );
}

console.log("touch long-press stands in for the right button:");
{
  assert(/@touchstart\.passive="onRowTouchStart\(\$event, \{ kind: 'dir', dir: d \}\)"/.test(SRC), "folder rows arm the long press");
  assert(/@touchstart\.passive="onRowTouchStart\(\$event, \{ kind: 'file', file: f \}\)"/.test(SRC), "file rows arm the long press");
  assert(/@touchmove\.passive="onRowTouchMove"/.test(SRC), "a drag cancels it");
  assert(/@touchend="cancelLongPress"/.test(SRC) && /@touchcancel="cancelLongPress"/.test(SRC), "lifting or cancelling clears the timer");
  const press = Number(SRC.match(/const LONG_PRESS_MS = (\d+)/)?.[1] ?? "0");
  assert(press >= 400 && press <= 800, `long-press threshold is ${press}ms`);
  // Touch browsers emit a click after the press; without the guard it would
  // both close the fresh menu and walk into the folder underneath.
  const guard = Number(SRC.match(/const CLICK_AFTER_PRESS_MS = (\d+)/)?.[1] ?? "0");
  assert(guard > press - 400, "a click-after-press window exists");
  assert(
    /function onDirRowClick[\s\S]*?Date\.now\(\) - longPressAt < CLICK_AFTER_PRESS_MS/.test(SRC),
    "the click a long-press leaves behind does not enter the folder",
  );
  assert(
    /function onDocumentClick[\s\S]*?Date\.now\(\) - longPressAt < CLICK_AFTER_PRESS_MS/.test(SRC),
    "the click a long-press leaves behind does not close the menu",
  );
  assert(
    /@media \(pointer: coarse\) \{[\s\S]*?-webkit-touch-callout: none/.test(SRC),
    "touch devices don't raise a selection callout over the press",
  );
}

console.log("folder rename rides on moveFolder:");
{
  const fn = SRC.match(/async function confirmRenameDir\([\s\S]*?\n}/)?.[0] ?? "";
  assert(fn.length > 0, "confirmRenameDir exists");
  assert(/storagePost\("files\/moveFolder"/.test(fn), "renames go through files/moveFolder");
  // Same parent in, same parent out — that is what makes a move a rename.
  assert(
    /path: joinPath\(path\.value, d\.name\)/.test(fn) && /dest: joinPath\(path\.value, newName\)/.test(fn),
    "source and destination share the current directory",
  );
  assert(/newName === d\.name/.test(fn), "an unchanged name is a no-op");
  assert(/\/\[\\\\\/\]\/\.test\(newName\)/.test(fn), "path separators are rejected");
  assert(/showToast\(t\("files\.folderRenamed"\)\)/.test(fn), "success is reported");
  assert(/loadDir\(\)/.test(fn), "the listing is reloaded");
  // The inline editor must not double as a click into the folder.
  assert(
    /function onDirRowClick[\s\S]*?renamingDir\.value === d\.name/.test(SRC),
    "clicking the row being renamed doesn't enter the folder",
  );
  assert(/renamingDir\.value = null/.test(SRC.match(/async function loadDir\([\s\S]*?\n}/)?.[0] ?? ""), "navigating drops a half-finished rename");
}

console.log("folder operations stay on the source that supports them:");
{
  // moveFolder/deleteFolder are R2-only (worker/src/endpoints/storage/files.ts).
  const dirMenu = SRC.match(/<template v-else-if="ctxDir">[\s\S]*?<\/template>\s*\n\s*<template v-else>/)?.[0] ?? "";
  assert(dirMenu.length > 0, "the folder menu block is present");
  assert(/v-if="isR2 && canUpload"/.test(dirMenu), "rename/move/delete are gated on R2 + upload permission");
  for (const key of ["renameFolder", "moveFolderTo", "deleteFolder"]) {
    assert(dirMenu.includes(`files.${key}`), `folder menu offers ${key}`);
  }
  assert(/t\("files\.open"\)/.test(dirMenu), "folder menu offers Open");
}

console.log("a menu on a multi-selection drives the whole selection:");
{
  const sel = SRC.match(/const ctxOnSelection = computed\([\s\S]*?\n\}\);/)?.[0] ?? "";
  assert(/selectedTotal\.value < 2/.test(sel), "a single row is not treated as a selection");
  assert(/selectedFiles\.value\.has\(target\.file\.uri\)/.test(sel), "a file counts only when it is selected");
  assert(/selectedDirs\.value\.has\(target\.dir\.name\)/.test(sel), "a folder counts only when it is selected");
  const batch = SRC.match(/<template v-if="ctxOnSelection">[\s\S]*?<\/template>/)?.[0] ?? "";
  for (const fn of ["openBatchTagEditor", "openBatchMoveModal", "openCrossModalBatch", "openBatchDeleteConfirm", "clearSelection"]) {
    assert(batch.includes(fn), `batch menu reuses ${fn}`);
  }
}

console.log("every label the view asks for exists in both locales:");
{
  const used = new Set([...SRC.matchAll(/t\("(files\.[\w.]+)"/g)].map((m) => m[1]));
  assert(used.size > 15, `${used.size} files.* keys referenced by the view`);
  for (const locale of ["en", "zh-CN"]) {
    const messages = JSON.parse(readFileSync(join(ROOT, "web", "src", "locales", `${locale}.json`), "utf8"));
    const missing = [...used].filter((key) => {
      let node: unknown = messages;
      for (const seg of key.split(".")) {
        if (!node || typeof node !== "object") return true;
        node = (node as Record<string, unknown>)[seg];
      }
      return typeof node !== "string";
    });
    assert(missing.length === 0, missing.length ? `${locale}.json missing: ${missing.join(", ")}` : `${locale}.json covers all of them`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
