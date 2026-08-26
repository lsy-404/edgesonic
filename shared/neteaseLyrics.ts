// SPDX-License-Identifier: AGPL-3.0-or-later

/** Convert NetEase's JSON-per-line lyric payload to ordinary timestamped LRC. */
export interface NetEaseLyricLine {
  time: number;
  text: string;
}

/** Parse one NetEase JSON lyric line for consumers that already have structure. */
export function parseNetEaseLyricLine(payload: unknown): NetEaseLyricLine | null {
  if (typeof payload !== "string") return null;
  const source = payload.trim();
  if (!source.startsWith("{")) return null;
  try {
    const value = JSON.parse(source) as { t?: unknown; c?: unknown };
    if (typeof value.t !== "number" || !Number.isFinite(value.t) || value.t < 0 || !Array.isArray(value.c)) return null;
    const text = value.c.map((part) => part && typeof part === "object" && typeof (part as { tx?: unknown }).tx === "string" ? (part as { tx: string }).tx : "").join("");
    return text ? { time: Math.round(value.t), text } : null;
  } catch {
    return null;
  }
}

export function parseNetEaseLyrics(payload: unknown): string {
  if (typeof payload !== "string" || !payload.trim()) return typeof payload === "string" ? payload : "";
  const parsed: Array<{ time: number; text: string; index: number }> = [];
  let sawJsonLine = false;
  for (const [index, raw] of payload.split(/\r?\n/).entries()) {
    const source = raw.trim();
    if (!source.startsWith("{")) continue;
    sawJsonLine = true;
    const value = parseNetEaseLyricLine(source);
    if (value) parsed.push({ ...value, index });
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
