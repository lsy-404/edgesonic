// SPDX-License-Identifier: AGPL-3.0-or-later

/** Convert NetEase's JSON-per-line lyric payload to ordinary timestamped LRC. */
export interface NetEaseLyricLine {
  time: number;
  text: string;
}

/** Credits embedded as timestamped NetEase lines belong to track metadata, not the lyric viewport. */
export function isNetEaseLyricMetadata(text: string): boolean {
  return /^(?:作词|填词|作曲|编曲|制作人|监制|演唱|和声|混音|母带|录音|配唱制作人|人声编辑|调教|分轨|吉他|贝斯|鼓|钢琴|键盘|企划|出品|发行|版权|翻译|校对|字幕|原唱)\s*[:：]/i.test(text.trim());
}

/** Parse one NetEase JSON lyric line for consumers that already have structure. */
export function parseNetEaseLyricLine(payload: unknown): NetEaseLyricLine | null {
  let value: Record<string, unknown>;
  if (typeof payload === "string") {
    const source = payload.trim();
    if (!source.startsWith("{")) return null;
    try {
      value = JSON.parse(source) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    value = payload as Record<string, unknown>;
  } else {
    return null;
  }

  const rawTime = value.t ?? value.time ?? value.startTime ?? value.start;
  const time = typeof rawTime === "number" ? rawTime : typeof rawTime === "string" ? Number(rawTime) : NaN;
  if (!Number.isFinite(time) || time < 0) return null;

  const text = Array.isArray(value.c)
    ? value.c.map((part) => lyricText(part)).join("")
    : lyricText(value);
  return text ? { time: Math.round(time), text } : null;
}

function lyricText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  for (const key of ["tx", "text", "lyric", "content"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  return "";
}

function parsePayloadLines(payload: string): Array<{ time: number; text: string; index: number }> {
  const source = payload.trim();
  if (!source) return [];
  try {
    const whole = JSON.parse(source) as unknown;
    let entries: unknown[] = [];
    if (Array.isArray(whole)) entries = whole;
    else if (whole && typeof whole === "object") {
      const record = whole as Record<string, unknown>;
      entries = Array.isArray(record.lines) ? record.lines
        : Array.isArray(record.lyrics) ? record.lyrics
          : Array.isArray(record.data) ? record.data
            : [record];
    }
    const parsed = entries
      .map((entry, index) => {
        const line = parseNetEaseLyricLine(entry);
        return line ? { ...line, index } : null;
      })
      .filter((line): line is { time: number; text: string; index: number } => line !== null);
    if (parsed.length > 0) return parsed;
  } catch {
    // Fall through to the historical newline-delimited form.
  }

  return payload.split(/\r?\n/).flatMap((raw, index) => {
    const line = parseNetEaseLyricLine(raw);
    return line ? [{ ...line, index }] : [];
  });
}

export function parseNetEaseLyrics(payload: unknown): string {
  if (typeof payload !== "string" || !payload.trim()) return typeof payload === "string" ? payload : "";
  const parsed = parsePayloadLines(payload);
  if (parsed.length === 0) return payload;
  const lyricLines = parsed.filter(({ text }) => !isNetEaseLyricMetadata(text));
  lyricLines.sort((a, b) => a.time - b.time || a.index - b.index);
  return lyricLines.map(({ time, text }) => `[${formatLrcTime(time)}]${text}`).join("\n");
}

function formatLrcTime(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}
