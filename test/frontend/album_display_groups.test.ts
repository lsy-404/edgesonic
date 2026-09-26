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
  it("shows the group at the first fetched member and suppresses later members", () => {
    const firstPage = [{ id: "edition-middle" }, { id: "ordinary" }];
    const firstPageCards = foldAlbumDisplayCards(firstPage, [group]);
    assert.deepEqual(firstPageCards.map((item) => item.key), ["group:group-a", "album:ordinary"]);
    const firstRepresentative = firstPageCards.find((item) => item.kind === "group");

    const allFetched = [...firstPage, { id: "edition-anchor" }, { id: "edition-last" }];
    const cards = foldAlbumDisplayCards(allFetched, [group]);
    assert.equal(cards.filter((item) => item.kind === "group").length, 1);
    const groupCard = cards.find((item) => item.kind === "group");
    assert.equal(groupCard?.kind === "group" ? groupCard.representative.id : "", "edition-middle");
    assert.equal(firstRepresentative?.kind === "group" ? firstRepresentative.representative.id : "", "edition-middle");
    assert.deepEqual(cards.filter((item) => item.kind === "album").map((item) => item.album.id), ["ordinary"]);
  });

  it("preserves ungrouped albums", () => {
    const cards = foldAlbumDisplayCards([{ id: "ordinary-a" }, { id: "ordinary-b" }], [group]);
    assert.deepEqual(cards.map((item) => item.key), ["album:ordinary-a", "album:ordinary-b"]);
  });
});
