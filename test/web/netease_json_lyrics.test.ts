// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseNetEaseLyrics } from "../../shared/neteaseLyrics";

const payload = [
  JSON.stringify({ t: 342, c: [{ tx: "文本" }, { tx: "作曲：" }, { tx: "某人", li: "https://image", or: "orpheus://artist" }], extra: true }),
  JSON.stringify({ t: 0, c: [{ tx: "作词：" }, { tx: "樊清", li: "https://image" }] }),
].join("\n");
const expected = "[00:00.000]作词：樊清\n[00:00.342]文本作曲：某人";
if (parseNetEaseLyrics(payload) !== expected) throw new Error("parser did not create the expected timeline");
if (parseNetEaseLyrics("[00:01.00]ordinary LRC") !== "[00:01.00]ordinary LRC") throw new Error("LRC regression");
if (parseNetEaseLyrics("plain lyrics") !== "plain lyrics") throw new Error("plain lyric regression");
if (parseNetEaseLyrics('{"t":"bad","c":[{"tx":"ignored"}]}\n{"t":100,"c":[{},null,{"tx":"ok"}]}') !== "[00:00.100]ok") throw new Error("malformed/empty fragments regression");
if (parseNetEaseLyrics('{"t":100,"c":[]}') !== '{"t":100,"c":[]}') throw new Error("empty payload should not be rewritten");
if (parseNetEaseLyrics(JSON.stringify([{ t: "1200", c: [{ tx: "第一" }, { tx: "句" }] }, { time: 2450, content: "第二句" }])) !== "[00:01.200]第一句\n[00:02.450]第二句") {
  throw new Error("JSON array lyric parser regression");
}
if (parseNetEaseLyrics(JSON.stringify({ lyrics: [{ startTime: "3000", text: "包装行" }] })) !== "[00:03.000]包装行") {
  throw new Error("wrapped JSON lyric parser regression");
}
console.log("netease JSON lyric parser: PASS");
