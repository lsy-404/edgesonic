import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const base = process.env.WORKMODE_RUNTIME_URL || "http://127.0.0.1:8798";
const fixtureDir = process.env.WORKMODE_FIXTURE_DIR;
if (!fixtureDir) throw new Error("Set WORKMODE_FIXTURE_DIR to the generated browser fixture directory");
const source = new Uint8Array(await readFile(`${fixtureDir}/fixture.wav`));
const flac = new Uint8Array(await readFile(`${fixtureDir}/converted.flac`));
const sourceSha = createHash("sha256").update(source).digest("hex");
const outputSha = createHash("sha256").update(flac).digest("hex");
const pcmSha = "6a105841b7384251ddfb09c035c8931f5b19bde840f4838c63c95492df128f30";
const evidence = {
  sampleRate: 44100,
  channels: 2,
  bitsPerSample: 16,
  sourceBytes: source.byteLength,
  outputBytes: flac.byteLength,
  metadataPreserved: true,
};
assert.equal(source.byteLength, 882378);
assert.equal(flac.byteLength, 69887);
assert.equal(sourceSha, "f8792785aa3f04e6d847950751f283e6187bf075c9d936e02f15197100298be3");
assert.equal(outputSha, "5889ffa2c680f1b108b1f5f7562baa8cf80a1c14712bef8935f4381308d21a2a");

async function json(path, init) {
  const url = /^https?:\/\//i.test(path) ? path : new URL(path, base).toString();
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

async function seed(mode) {
  const { response, body } = await json("/__fixture/seed", { method: "POST", body: source });
  assert.equal(response.status, 200, "fixture seed should create local D1/R2 claim");
  if (mode) {
    const changed = await json("/__fixture/mutate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: body.id, mode }),
    });
    assert.equal(changed.response.status, 200, `fixture mutation ${mode}`);
  }
  return body;
}

function uploadHeaders(task, body = flac, outputSha256 = outputSha) {
  return {
    "Content-Type": "audio/flac",
    "X-Work-Attempt": String(task.attempts),
    "X-Work-Claimed-At": String(task.claimedAt),
    "X-Source-SHA256": sourceSha,
    "X-Source-PCM-SHA256": pcmSha,
    "X-Output-SHA256": outputSha256,
    "X-Output-PCM-SHA256": pcmSha,
    "X-Verification-JSON": JSON.stringify({ ...evidence, outputBytes: body.byteLength }),
  };
}

async function upload(task, body = flac, outputSha256 = outputSha) {
  return json(task.uploadUrl, {
    method: "POST", headers: uploadHeaders(task, body, outputSha256), body,
  });
}

async function state(task) {
  return json(`/__fixture/state?id=${encodeURIComponent(task.id)}`).then(({ body }) => body);
}

const health = await json("/__fixture/health");
assert.deepEqual(health.body, { ok: true, runtime: "workerd" });
const initialized = await json("/__fixture/init", { method: "POST" });
assert.equal(initialized.response.status, 200);

const success = await seed();
const sourceResponse = await fetch(success.sourceUrl);
assert.equal(sourceResponse.status, 200, "real source route should return the R2-backed WAV");
assert.deepEqual(new Uint8Array(await sourceResponse.arrayBuffer()), source);

const completed = await upload(success);
assert.equal(completed.response.status, 200, `browser FLAC upload should register: ${JSON.stringify(completed.body)}`);
assert.equal(completed.body.registered, true);
assert.equal(completed.body.instanceId, success.instanceId);
const successfulState = await state(success);
assert.equal(successfulState.task.status, "completed");
assert.equal(successfulState.instance.storage_uri, `r2://${completed.body.r2Key}`);
assert.equal(successfulState.instance.suffix, "flac");
assert.equal(successfulState.instance.duration, 5);
assert.equal(successfulState.instance.bit_rate, Math.floor(flac.byteLength * 8 / 5 / 1000), "FLAC bitrate uses the five-second fixture duration");
assert.equal(successfulState.instance.master_id, success.masterId, "replacement preserves the original master ID");
assert.equal(successfulState.relatedInstances.find((item) => item.id === success.userRefInstanceId)?.storage_uri,
  `legacy://user-reference/${success.id.slice("wt-lossless-si-fixture-".length)}.mp3`, "sibling user reference remains unchanged");
assert.equal(successfulState.entries.find((entry) => entry.instance_id === success.instanceId)?.path, success.entryPath.replace(/\.wav$/i, ".flac"));
assert.deepEqual(successfulState.companions.filter((entry) => entry.id === success.companionEntryId).map((entry) => ({
  path: entry.path, object_id: entry.object_id, companion_of: entry.companion_of,
})), [{ path: success.entryPath.replace(/\.wav$/i, ".lrc"), object_id: success.companionObjectId, companion_of: success.entryId }],
"replacement preserves the linked LRC companion entry");
assert.ok(successfulState.objects.some((object) => object.physical_key === completed.body.r2Key && object.suffix === "flac"));
assert.ok(!successfulState.objects.some((object) => object.id === success.sourceObjectId), "unreferenced original object should retire after atomic catalog switch");
assert.ok(successfulState.r2Keys.some((item) => item.key === completed.body.r2Key && item.size === flac.byteLength));
assert.ok(successfulState.r2Keys.some((item) => item.key === success.companionKey && item.size > 0), "companion R2 bytes remain available");

const replay = await upload(success);
assert.equal(replay.response.status, 200, "identical upload replay should return the completed receipt");
assert.equal(replay.body.replayed, true);
const submit = await json("/edgesonic/work/submit", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: success.id, attempts: success.attempts, claimedAt: success.claimedAt }),
});
assert.equal(submit.response.status, 200, "work submit replay should accept only the verified lossless receipt");
assert.equal(submit.body.replayed, true);

for (const mode of ["claim", "snapshot"]) {
  const stale = await seed(mode);
  const result = await upload(stale);
  assert.equal(result.response.status, 409, `${mode} change must reject upload`);
  const current = await state(stale);
  assert.equal(current.instance.storage_uri, stale.sourceUri, `${mode} rejection preserves source catalog`);
  assert.notEqual(current.task.status, "completed", `${mode} rejection creates no receipt`);
}

for (const [label, body] of [["short", flac.subarray(0, flac.byteLength - 1)], ["long", new Uint8Array([...flac, 0])]]) {
  const malformed = await seed();
  const beforeMalformed = await state(malformed);
  const outputCountBefore = beforeMalformed.objects.filter((object) => object.suffix === "flac").length;
  const storedFlacCountBefore = beforeMalformed.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length;
  const result = await upload(malformed, body);
  assert.notEqual(result.response.status, 200, `${label} output body cannot produce a receipt`);
  const current = await state(malformed);
  assert.equal(current.instance.storage_uri, malformed.sourceUri, `${label} body leaves source catalog unchanged`);
  assert.notEqual(current.task.status, "completed", `${label} body leaves task uncompleted`);
  assert.equal(current.objects.filter((object) => object.suffix === "flac").length, outputCountBefore, `${label} body leaves no registered output object`);
  assert.equal(current.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length, storedFlacCountBefore, `${label} body removes unreferenced R2 output`);
}

const badDigest = await seed();
const beforeBadDigest = await state(badDigest);
const badDigestObjectCount = beforeBadDigest.objects.filter((object) => object.suffix === "flac").length;
const badDigestR2Count = beforeBadDigest.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length;
const badDigestResult = await upload(badDigest, flac, "0".repeat(64));
assert.equal(badDigestResult.response.status, 422, "valid-size FLAC with a false output digest must be rejected after R2 streaming");
const badDigestState = await state(badDigest);
assert.equal(badDigestState.instance.storage_uri, badDigest.sourceUri);
assert.notEqual(badDigestState.task.status, "completed");
assert.equal(badDigestState.objects.filter((object) => object.suffix === "flac").length, badDigestObjectCount);
assert.equal(badDigestState.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length, badDigestR2Count,
  "digest mismatch cleanup leaves no R2 orphan before object registration");

const collision = await seed("collision");
const beforeCollision = await state(collision);
const collisionObjectCountBefore = beforeCollision.objects.filter((object) => object.suffix === "flac").length;
const collisionR2CountBefore = beforeCollision.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length;
const conflict = await upload(collision);
assert.notEqual(conflict.response.status, 200, "path collision must fail the atomic catalog batch");
const conflictState = await state(collision);
assert.equal(conflictState.instance.storage_uri, collision.sourceUri, "failed batch keeps the source instance");
assert.equal(conflictState.entries.find((entry) => entry.instance_id === collision.instanceId)?.path, collision.entryPath);
assert.equal(conflictState.objects.filter((object) => object.suffix === "flac").length, collisionObjectCountBefore, "failed batch cleans the unreferenced output object");
assert.equal(conflictState.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length, collisionR2CountBefore, "failed batch removes its unreferenced R2 output");

for (const mode of ["shared", "legacy"]) {
  const retained = await seed(mode);
  const result = await upload(retained);
  assert.equal(result.response.status, 200, `${mode} references should not prevent replacement`);
  const retainedState = await state(retained);
  assert.ok(retainedState.objects.some((object) => object.id === retained.sourceObjectId), `${mode} reference must retain old object metadata`);
  assert.ok(retainedState.r2Keys.some((item) => item.key === retained.sourceKey && item.size === source.byteLength), `${mode} reference must retain old R2 bytes`);
}

const uppercase = await seed("uppercase");
const uppercaseResult = await upload(uppercase);
assert.equal(uppercaseResult.response.status, 200, "uppercase WAV instance suffix should pass the source snapshot check");
const uppercaseState = await state(uppercase);
assert.equal(uppercaseState.instance.suffix, "flac");
assert.equal(uppercaseState.entries.find((entry) => entry.instance_id === uppercase.instanceId)?.path, uppercase.entryPath.replace(/\.wav$/i, ".flac"));

const concurrent = await seed();
const beforeConcurrent = await state(concurrent);
const concurrentObjectCount = beforeConcurrent.objects.filter((object) => object.suffix === "flac").length;
const concurrentR2Count = beforeConcurrent.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length;
const concurrentResults = await Promise.all([upload(concurrent), upload(concurrent)]);
assert.ok(concurrentResults.some((result) => result.response.status === 200), "same-claim upload race must leave a registered winner");
const concurrentState = await state(concurrent);
assert.equal(concurrentState.task.status, "completed");
assert.equal(concurrentState.instance.suffix, "flac");
assert.equal(concurrentState.objects.filter((object) => object.suffix === "flac").length, concurrentObjectCount + 1,
  "same-claim upload race registers only one winning object");
assert.equal(concurrentState.r2Keys.filter((item) => item.key.endsWith(".flac") && item.size !== null).length, concurrentR2Count + 1,
  "losing upload nonce cannot delete or leave a competing FLAC object");
const winningUri = concurrentState.instance.storage_uri;
assert.ok(concurrentState.r2Keys.some((item) => `r2://${item.key}` === winningUri && item.size === flac.byteLength),
  "the active instance points to the surviving FLAC object");

console.log("PASS: workerd real-route lossless upload/catalog tests using browser-produced FLAC");
