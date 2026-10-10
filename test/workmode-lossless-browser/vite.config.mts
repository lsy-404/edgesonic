import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuffer } from "music-metadata";
import { defineConfig, type Plugin } from "vite";
import { createTaggedWav, sha256 } from "./fixture.mjs";
import { assertMetadataPreserved } from "../../web/src/lib/wavFlacConvertCore.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = resolve(root, "../..");
const artifactDir = resolve(repository, "test/artifacts/workmode-lossless-browser");
const fixture = createTaggedWav();
const sourceSha256 = sha256(fixture);
const expectedInstance = "fixture-source-instance";
const expectedAttempt = "2";
const expectedClaimedAt = "1800000000";
let uploaded: Buffer | undefined;
let report: {
  fixture?: unknown;
  upload?: { verified?: boolean; [key: string]: unknown };
  submission?: { accepted?: boolean; [key: string]: unknown };
  [key: string]: unknown;
} = {
  fixture: { sourceBytes: fixture.length, sourceSha256, expectedInstance, expectedAttempt, expectedClaimedAt },
};
const fixtureMetadataPromise = parseBuffer(fixture, { mimeType: "audio/wav", size: fixture.length });

function json(res: any, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value, null, 2));
}

async function requestBody(req: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function metadataSummary(metadata: Awaited<ReturnType<typeof parseBuffer>>) {
  const summarize = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return { bytes: value.byteLength, sha256: sha256(Buffer.from(value)) };
    if (Array.isArray(value)) return value.map(summarize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarize(item)]));
    }
    return value;
  };
  const native = Object.fromEntries(Object.entries(metadata.native).map(([format, tags]) => [
    format,
    tags.map((tag) => ({ id: tag.id, value: summarize(tag.value) })),
  ]));
  const picture = metadata.common.picture?.map((entry) => ({
    format: entry.format,
    type: entry.type,
    description: entry.description,
    bytes: entry.data.byteLength,
    sha256: sha256(Buffer.from(entry.data)),
  })) || [];
  return {
    common: {
      title: metadata.common.title,
      artist: metadata.common.artist,
      artists: metadata.common.artists,
      album: metadata.common.album,
      albumartist: metadata.common.albumartist,
      year: metadata.common.year,
      track: metadata.common.track,
      comment: metadata.common.comment,
      lyrics: metadata.common.lyrics,
      picture,
    },
    native,
    format: {
      container: metadata.format.container,
      codec: metadata.format.codec,
      sampleRate: metadata.format.sampleRate,
      numberOfChannels: metadata.format.numberOfChannels,
      bitsPerSample: metadata.format.bitsPerSample,
      numberOfSamples: metadata.format.numberOfSamples,
    },
  };
}

async function expectMetadataLoss(source: Buffer, output: Buffer, label: string) {
  try {
    await assertMetadataPreserved(source, output);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "metadata_loss") return label;
    throw error;
  }
  throw new Error(`Verifier accepted the ${label} metadata change.`);
}

function rewriteId3(source: Buffer, update: (frames: Array<{ id: string; body: Buffer }>) => Array<{ id: string; body: Buffer }>) {
  const chunks: Array<{ id: string; data: Buffer }> = [];
  for (let offset = 12; offset + 8 <= source.length;) {
    const id = source.toString("latin1", offset, offset + 4);
    const size = source.readUInt32LE(offset + 4);
    const start = offset + 8;
    const data = Buffer.from(source.subarray(start, start + size));
    if (id === "id3 ") {
      const tagHeader = data.subarray(0, 10);
      const frames: Array<{ id: string; body: Buffer }> = [];
      for (let pos = 10; pos + 10 <= data.length;) {
        const frameId = data.toString("latin1", pos, pos + 4);
        const frameSize = data.readUInt32BE(pos + 4);
        if (!/^[A-Z0-9]{4}$/u.test(frameId) || frameSize <= 0 || pos + 10 + frameSize > data.length) break;
        frames.push({ id: frameId, body: Buffer.from(data.subarray(pos + 10, pos + 10 + frameSize)) });
        pos += 10 + frameSize;
      }
      const frameBytes = Buffer.concat(update(frames).map(({ id: frameId, body }) => {
        const header = Buffer.alloc(10);
        header.write(frameId, 0, 4, "latin1");
        header.writeUInt32BE(body.length, 4);
        return Buffer.concat([header, body]);
      }));
      const sizeBytes = Buffer.from([(frameBytes.length >> 21) & 127, (frameBytes.length >> 14) & 127,
        (frameBytes.length >> 7) & 127, frameBytes.length & 127]);
      chunks.push({ id, data: Buffer.concat([tagHeader.subarray(0, 6), sizeBytes, frameBytes]) });
    } else chunks.push({ id, data });
    offset = start + size + (size & 1);
  }
  const encodedChunks = Buffer.concat(chunks.map(({ id, data }) => {
    const header = Buffer.alloc(8);
    header.write(id, 0, 4, "latin1");
    header.writeUInt32LE(data.length, 4);
    return data.length & 1 ? Buffer.concat([header, data, Buffer.from([0])]) : Buffer.concat([header, data]);
  }));
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, 4, "latin1");
  riff.writeUInt32LE(4 + encodedChunks.length, 4);
  return Buffer.concat([riff, Buffer.from("WAVE"), encodedChunks]);
}

const fixturePlugin: Plugin = {
  name: "workmode-lossless-loopback-fixture",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url || "").split("?", 1)[0];
      try {
        if (req.method === "GET" && path === "/fixture/source") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("Content-Length", fixture.length);
          res.end(fixture);
          return;
        }
        if (req.method === "GET" && path === "/fixture/report") {
          report.fixture = {
            sourceBytes: fixture.length,
            sourceSha256,
            expectedInstance,
            expectedAttempt,
            expectedClaimedAt,
            metadata: metadataSummary(await fixtureMetadataPromise),
          };
          json(res, report);
          return;
        }
        if (req.method === "GET" && path === "/fixture/output") {
          if (!uploaded) return json(res, { error: "No output has been uploaded yet." }, 404);
          res.statusCode = 200;
          res.setHeader("Content-Type", "audio/flac");
          res.setHeader("Content-Length", uploaded.length);
          res.setHeader("Content-Disposition", "attachment; filename=fixture-lossless.flac");
          res.end(uploaded);
          return;
        }
        if (req.method === "POST" && path === "/fixture/upload") {
          const bytes = await requestBody(req);
          const headers = req.headers;
          const evidence = JSON.parse(String(headers["x-verification-json"] || "{}"));
          const expectedOutputHash = sha256(bytes);
          const sourceMetadata = await parseBuffer(fixture, { mimeType: "audio/wav", size: fixture.length });
          const outputMetadata = await parseBuffer(bytes, { mimeType: "audio/flac", size: bytes.length });
          await assertMetadataPreserved(fixture, bytes);
          const negativeChecks: string[] = [];
          for (const [label, marker] of [
            ["lyrics", "Fixture lyrics line one"],
            ["comment", "Fixture comment"],
            ["date", "2024"],
          ]) {
            const changed = Buffer.from(fixture);
            const position = changed.indexOf(Buffer.from(marker));
            if (position < 0) throw new Error(`Generated fixture ${label} was not found.`);
            changed[position] ^= 1;
            negativeChecks.push(await expectMetadataLoss(changed, bytes, label));
          }
          const cover = Buffer.from(sourceMetadata.common.picture?.[0]?.data ?? []);
          if (!cover.length) throw new Error("Generated fixture cover was not parsed.");
          const coverPosition = fixture.indexOf(cover);
          if (coverPosition < 0) throw new Error("Generated fixture cover bytes were not found.");
          const changedCover = Buffer.from(fixture);
          changedCover[coverPosition + cover.length - 1] ^= 1;
          negativeChecks.push(await expectMetadataLoss(changedCover, bytes, "cover"));
          const describedComment = rewriteId3(fixture, (frames) => frames.map((frame) => frame.id === "COMM"
            ? { ...frame, body: Buffer.concat([Buffer.from([0]), Buffer.from("engreview\0", "latin1"), Buffer.from("Fixture comment")]) }
            : frame));
          negativeChecks.push(await expectMetadataLoss(describedComment, bytes, "comment descriptor"));
          const preciseDate = rewriteId3(fixture, (frames) => frames.map((frame) => frame.id === "TYER"
            ? { id: "TDRC", body: Buffer.concat([Buffer.from([0]), Buffer.from("2024-02-03")]) }
            : frame));
          negativeChecks.push(await expectMetadataLoss(preciseDate, bytes, "date precision"));
          const customTag = rewriteId3(fixture, (frames) => [...frames, {
            id: "TXXX", body: Buffer.concat([Buffer.from([0]), Buffer.from("CUSTOM\0unmapped value")]),
          }]);
          negativeChecks.push(await expectMetadataLoss(customTag, bytes, "custom native tag"));
          const valid = headers["content-type"] === "audio/flac"
            && headers["x-source-sha256"] === sourceSha256
            && headers["x-output-sha256"] === expectedOutputHash
            && /^[a-f0-9]{64}$/u.test(String(headers["x-source-pcm-sha256"] || ""))
            && headers["x-source-pcm-sha256"] === headers["x-output-pcm-sha256"]
            && evidence.sourceBytes === fixture.length
            && evidence.outputBytes === bytes.length
            && evidence.sampleRate === 44100
            && evidence.channels === 2
            && evidence.bitsPerSample === 16
            && evidence.metadataPreserved === true
            && bytes.length < fixture.length
            && headers["x-work-attempt"] === expectedAttempt
            && headers["x-work-claimed-at"] === expectedClaimedAt;
          if (!valid) {
            report.upload = { accepted: false, error: "Upload evidence did not match the local generated fixture." };
            return json(res, { ok: false, error: "fixture evidence mismatch" }, 400);
          }
          uploaded = bytes;
          await mkdir(artifactDir, { recursive: true });
          await writeFile(resolve(artifactDir, "fixture.wav"), fixture);
          await writeFile(resolve(artifactDir, "converted.flac"), bytes);
          const output = {
            sha256: expectedOutputHash,
            bytes: bytes.length,
            negativeChecks,
            sourceMetadata: metadataSummary(sourceMetadata),
            outputMetadata: metadataSummary(outputMetadata),
            verificationHeaders: {
              sourceSha256: headers["x-source-sha256"],
              outputSha256: headers["x-output-sha256"],
              sourcePcmSha256: headers["x-source-pcm-sha256"],
              outputPcmSha256: headers["x-output-pcm-sha256"],
              verification: evidence,
              attempt: headers["x-work-attempt"],
              claimedAt: headers["x-work-claimed-at"],
            },
          };
          await writeFile(resolve(artifactDir, "server-output.json"), JSON.stringify(output, null, 2));
          report.upload = { accepted: true, verified: true, ...output };
          return json(res, { ok: true, registered: true, r2Key: "fixture/converted.flac", size: bytes.length, instanceId: expectedInstance });
        }
        if (req.method === "POST" && path === "/fixture/work/submit") {
          const body = JSON.parse((await requestBody(req)).toString("utf8"));
          const accepted = body.id === "fixture-lossless-task" && body.result?.registered === true
            && body.result?.instanceId === expectedInstance && report.upload?.verified === true;
          report.submission = { accepted, body };
          if (accepted) await writeFile(resolve(artifactDir, "submission.json"), JSON.stringify(body, null, 2));
          return json(res, { ok: accepted }, accepted ? 200 : 409);
        }
        if (req.method === "POST" && path === "/fixture/work/heartbeat") return json(res, { ok: true });
        next();
      } catch (error) {
        console.error("Local fixture endpoint failed:", error);
        report.error = error instanceof Error ? error.message : String(error);
        json(res, { ok: false, error: report.error }, 500);
      }
    });
  },
};

export default defineConfig({
  root,
  plugins: [fixturePlugin],
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
    fs: { allow: [repository] },
  },
});
