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
console.log("netease JSON lyric parser: PASS");
