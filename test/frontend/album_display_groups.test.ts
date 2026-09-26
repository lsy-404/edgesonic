// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldAlbumDisplayCards, type AlbumDisplayGroupSummary } from "../../web/src/lib/albumDisplayGroups";

const group: AlbumDisplayGroupSummary = {
  id: "group-a",
  name: "Album",
  memberAlbumIds: ["edition-anchor", "edition-middle", "edition-last"],
  memberCount: 3,
};

describe("album display card projection", () => {
  it("waits for the stable member anchor and emits one group card across pages", () => {
    const nonAnchorPage = [{ id: "edition-middle" }, { id: "ordinary" }];
    assert.deepEqual(foldAlbumDisplayCards(nonAnchorPage, [group]).map((item) => item.key), ["album:ordinary"]);

    const anchorPage = [{ id: "edition-anchor" }];
    const laterPage = [{ id: "edition-last" }];
    const allFetched = [...nonAnchorPage, ...anchorPage, ...laterPage];
    const cards = foldAlbumDisplayCards(allFetched, [group]);
    assert.equal(cards.filter((item) => item.kind === "group").length, 1);
    const groupCard = cards.find((item) => item.kind === "group");
    assert.equal(groupCard?.kind === "group" ? groupCard.representative.id : "", "edition-anchor");
    assert.deepEqual(cards.filter((item) => item.kind === "album").map((item) => item.album.id), ["ordinary"]);
  });
});
