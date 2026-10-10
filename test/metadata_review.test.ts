import assert from "node:assert/strict";
import test from "node:test";
import {
  metadataReviewRequest,
  metadataSnapshotFields,
  parseAutoState,
  parseMetadataReviewPage,
  type MetadataReviewItem,
} from "../web/src/lib/metadataReview";

const pending = {
  taskId: "wt-review",
  attempts: 2,
  payload: { identity: { title: "Track", artist: "Artist" } },
  result: { status: "pending", reason: "ambiguous", candidates: [
    { source: "netease", songId: "song-1", title: "Track", artist: "Artist", album: "Album" },
  ] },
};
const counts = { total: 5, incomplete: 3, complete: 2, pending: 1, kept: 1, queued: 2, claimed: 0 };

test("parses the opt-in state and bounded status pages", () => {
  assert.equal(parseAutoState({ ok: true, enabled: false }), false);
  assert.deepEqual(parseMetadataReviewPage({ ok: true, autoEnabled: true, counts, pending: [pending], nextCursor: "wt-review" }), {
    autoEnabled: true, counts, pending: [pending], nextCursor: "wt-review",
  });
});

test("rejects malformed or contradictory status pages", () => {
  assert.throws(() => parseAutoState({ ok: true, enabled: "yes" }));
  assert.throws(() => parseMetadataReviewPage({ ok: true, autoEnabled: false, counts: { ...counts, complete: 6 }, pending: [], nextCursor: null }));
  assert.throws(() => parseMetadataReviewPage({ ok: true, autoEnabled: false, counts: { ...counts, incomplete: 1, complete: 1 }, pending: [], nextCursor: null }));
  assert.throws(() => parseMetadataReviewPage({ ok: true, autoEnabled: false, counts, pending: Array(21).fill(pending), nextCursor: null }));
});

test("builds explicit keep and retry actions without an implicit decision", () => {
  const item = parseMetadataReviewPage({ ok: true, autoEnabled: false, counts, pending: [pending], nextCursor: null }).pending[0];
  assert.deepEqual(metadataReviewRequest(item, "keep"), { taskId: "wt-review", attempts: 2, decision: "keep" });
  assert.deepEqual(metadataReviewRequest(item, "retry"), { taskId: "wt-review", attempts: 2, decision: "retry" });
});

test("apply action must match the selected candidate identity", () => {
  const item = parseMetadataReviewPage({ ok: true, autoEnabled: false, counts, pending: [pending], nextCursor: null }).pending[0] as MetadataReviewItem;
  const result = { kind: "metadata-retrieval", status: "matched", match: { source: "netease", songId: "song-1", title: "Track", artist: "Artist" } };
  assert.equal(metadataReviewRequest(item, "apply", 0, result).decision, "apply");
  assert.throws(() => metadataReviewRequest(item, "apply", 0, { ...result, match: { ...result.match, songId: "wrong" } }));
  assert.throws(() => metadataReviewRequest(item, "apply", 0));
});

test("current metadata comes from the catalog snapshot, never retrieval identity hints", () => {
  assert.deepEqual(metadataSnapshotFields({
    identity: { title: "/source/folder/song.flac", artist: "folder" },
    snapshot: { title: "Catalog title", artist: "Catalog artist", album: "Catalog album" },
  }), { title: "Catalog title", artist: "Catalog artist", album: "Catalog album" });
  assert.deepEqual(metadataSnapshotFields({ identity: { title: "/source/song.flac" } }), {});
});
