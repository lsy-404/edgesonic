import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isScrollInsideElement,
  placeFloatingMenu,
  placeFloatingPoint,
  type FloatingRect,
} from "../../web/src/lib/floatingPlacement";

const ROOT = join(__dirname, "..", "..");

function rect(left: number, top: number, width: number, height: number): FloatingRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

console.log("floating placement uses the usable side of the viewport:");
{
  const placed = placeFloatingMenu(rect(700, 120, 28, 28), { width: 180, height: 160 }, {
    viewportWidth: 800,
    viewportHeight: 600,
    margin: 8,
    gap: 4,
  });
  assert.equal(placed.placement, "bottom");
  assert.equal(placed.left, 548);
  assert.equal(placed.top, 152);
  assert.ok(placed.maxHeight >= 160);
}

{
  const placed = placeFloatingMenu(rect(700, 540, 28, 28), { width: 180, height: 180 }, {
    viewportWidth: 800,
    viewportHeight: 600,
    margin: 8,
    gap: 4,
  });
  assert.equal(placed.placement, "top");
  assert.equal(placed.top, 356);
  assert.equal(placed.maxHeight, 528);
}

{
  const placed = placeFloatingPoint(760, 580, { width: 260, height: 300 }, {
    viewportWidth: 800,
    viewportHeight: 600,
    margin: 8,
    minHeight: 120,
  });
  assert.equal(placed.placement, "top");
  assert.equal(placed.left, 532);
  assert.equal(placed.top, 280);
  assert.equal(placed.maxHeight, 572);
}

{
  const placed = placeFloatingMenu(rect(32, 250, 28, 28), { width: 200, height: 500 }, {
    viewportWidth: 360,
    viewportHeight: 360,
    margin: 8,
    gap: 4,
    minHeight: 120,
  });
  assert.equal(placed.placement, "top");
  assert.equal(placed.top, 8);
  assert.equal(placed.maxHeight, 238);
}

console.log("Vue menus use the shared viewport placement contract:");
{
  const menu = {} as HTMLElement;
  assert.equal(
    isScrollInsideElement({ type: "scroll", composedPath: () => ["menu-child", menu, "page"] } as unknown as Event, menu),
    true,
  );
  assert.equal(
    isScrollInsideElement({ type: "scroll", composedPath: () => ["page"] } as unknown as Event, menu),
    false,
  );
  assert.equal(
    isScrollInsideElement({ type: "resize", composedPath: () => [menu, "page"] } as unknown as Event, menu),
    false,
  );
}

{
  const files = readFileSync(join(ROOT, "web", "src", "views", "Files.vue"), "utf8");
  assert.match(files, /isScrollInsideElement, placeFloatingPoint/);
  assert.match(files, /maxHeight: `\$\{ctxMenu\.value\?\.maxHeight \?\? 0\}px`/);
  assert.match(files, /placeFloatingPoint\(x, y, el\.getBoundingClientRect\(\), \{ margin: 8, minHeight: 120 \}\)/);
  assert.match(files, /\.ctx-menu \{[\s\S]*?position: fixed[\s\S]*?overflow-y: auto/);
  assert.match(files, /if \(event && isScrollInsideElement\(event, ctxMenuEl\.value\)\) return/);
}

{
  const songMenu = readFileSync(join(ROOT, "web", "src", "components", "SongRowMenu.vue"), "utf8");
  assert.match(songMenu, /<Teleport to="body">/);
  assert.match(songMenu, /placeFloatingMenu\(button\.getBoundingClientRect\(\), menu\.getBoundingClientRect\(\)/);
  assert.match(songMenu, /maxHeight: `\$\{menuPlacement\.value\.maxHeight\}px`/);
  assert.match(songMenu, /\.row-menu \{[\s\S]*?position: fixed[\s\S]*?overflow-y: auto/);
  assert.match(songMenu, /if \(isScrollInsideElement\(event, menuEl\.value\)\) return/);
}

{
  const optionsMenu = readFileSync(join(ROOT, "web", "src", "components", "ListOptionsMenu.vue"), "utf8");
  assert.match(optionsMenu, /<Teleport to="body">/);
  assert.match(optionsMenu, /placeFloatingMenu\(button\.getBoundingClientRect\(\), menu\.getBoundingClientRect\(\)/);
  assert.match(optionsMenu, /maxHeight: `\$\{menuPlacement\.value\.maxHeight\}px`/);
  assert.match(optionsMenu, /\.list-options-menu \{[\s\S]*?position: fixed[\s\S]*?overflow-y: auto/);
  assert.match(optionsMenu, /if \(isScrollInsideElement\(event, menuEl\.value\)\) return/);
}

{
  const library = readFileSync(join(ROOT, "web", "src", "views", "Library.vue"), "utf8");
  assert.match(library, /closest\("\.row-menu-wrap, \.row-menu"\)/);
  assert.match(library, /closest\("\.list-options-wrap, \.list-options-menu"\)/);
  assert.match(library, /@close="optionsOpen = false"/);
}

console.log("ALL PASS");
