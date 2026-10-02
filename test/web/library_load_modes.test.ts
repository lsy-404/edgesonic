import { strict as assert } from "node:assert";
import { test } from "node:test";
import { exactPageCount, validPageTarget, visibleLibraryItems } from "../../web/src/lib/librarySearch";

test("manual mode selects one page while automatic mode keeps the loaded prefix", () => {
  const items = Array.from({ length: 9 }, (_, index) => index + 1);

  assert.deepEqual(visibleLibraryItems(items, 2, 3, "manual"), [4, 5, 6]);
  assert.deepEqual(visibleLibraryItems(items, 2, 3, "automatic"), [1, 2, 3, 4, 5, 6]);
});

test("page counts require an exact total and include one empty page for an empty result", () => {
  assert.equal(exactPageCount(null, 20), null);
  assert.equal(exactPageCount(0, 20), 1);
  assert.equal(exactPageCount(40, 20), 2);
  assert.equal(exactPageCount(41, 20), 3);
});

test("page navigation rejects invalid jumps and allows direct selection only within known bounds", () => {
  assert.equal(validPageTarget(Number.NaN, 1, 23), null);
  assert.equal(validPageTarget(0, 1, 23), null);
  assert.equal(validPageTarget(-2, 1, 23), null);
  assert.equal(validPageTarget(24, 1, 23), null);
  assert.equal(validPageTarget(23, 1, 23), 23);
  assert.equal(validPageTarget(9999, 1, null), null);
  assert.equal(validPageTarget(2, 1, null), 2);
});
