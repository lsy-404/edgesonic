import { createHash } from "node:crypto";

const coverBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/8uoAAAAASUVORK5CYII=", "base64");
const text = (value) => Buffer.from(value, "latin1");

function synchsafe(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function frame(id, body) {
  const head = Buffer.alloc(10);
  text(id).copy(head, 0);
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function textFrame(id, value) {
  return frame(id, Buffer.concat([Buffer.from([0]), text(value)]));
}

function userTextFrame(id, value) {
  return frame(id, Buffer.concat([Buffer.from([0, 0x65, 0x6e, 0x67, 0]), text(value)]));
}

function makeId3() {
  const frames = [
    textFrame("TIT2", "Fixture Song"),
    textFrame("TPE1", "Fixture Artist"),
    textFrame("TALB", "Fixture Album"),
    textFrame("TPE2", "Fixture Album Artist"),
    textFrame("TYER", "2024"),
    textFrame("TRCK", "3/8"),
    userTextFrame("COMM", "Fixture comment"),
    userTextFrame("USLT", "Fixture lyrics line one\nFixture lyrics line two"),
    frame("APIC", Buffer.concat([Buffer.from([0]), text("image/png"), Buffer.from([0, 3, 0]), coverBytes])),
  ];
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0]), synchsafe(body.length), body]);
}

export function createTaggedWav() {
  const sampleRate = 44100;
  const channels = 2;
  const seconds = 5;
  const frames = sampleRate * seconds;
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frameIndex / sampleRate) * 9000);
    pcm.writeInt16LE(sample, frameIndex * 4);
    pcm.writeInt16LE(sample, frameIndex * 4 + 2);
  }
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * channels * 2, 8);
  format.writeUInt16LE(channels * 2, 12);
  format.writeUInt16LE(16, 14);
  const id3 = makeId3();
  const chunk = (id, data) => {
    const head = Buffer.alloc(8);
    text(id).copy(head);
    head.writeUInt32LE(data.length, 4);
    return data.length & 1 ? Buffer.concat([head, data, Buffer.from([0])]) : Buffer.concat([head, data]);
  };
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", format), chunk("id3 ", id3), chunk("data", pcm)]);
  const header = Buffer.alloc(8);
  text("RIFF").copy(header);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
