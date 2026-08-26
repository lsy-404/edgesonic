// SPDX-License-Identifier: AGPL-3.0-or-later

/** Convert NetEase's JSON-per-line lyric payload to ordinary timestamped LRC. */
export function parseNetEaseLyrics(payload: unknown): string {
  if (typeof payload !== "string" || !payload.trim()) return typeof payload === "string" ? payload : "";
  const parsed: Array<{ time: number; text: string; index: number }> = [];
  let sawJsonLine = false;
  for (const [index, raw] of payload.split(/\r?\n/).entries()) {
    const source = raw.trim();
    if (!source.startsWith("{")) continue;
    sawJsonLine = true;
    try {
      const value = JSON.parse(source) as { t?: unknown; c?: unknown };
      if (typeof value.t !== "number" || !Number.isFinite(value.t) || value.t < 0 || !Array.isArray(value.c)) continue;
      const text = value.c.map((part) => part && typeof part === "object" && typeof (part as { tx?: unknown }).tx === "string" ? (part as { tx: string }).tx : "").join("");
      if (text) parsed.push({ time: Math.round(value.t), text, index });
    } catch { /* Keep other valid lines. */ }
  }
  if (!sawJsonLine || parsed.length === 0) return payload;
  parsed.sort((a, b) => a.time - b.time || a.index - b.index);
  return parsed.map(({ time, text }) => `[${formatLrcTime(time)}]${text}`).join("\n");
}

function formatLrcTime(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}
