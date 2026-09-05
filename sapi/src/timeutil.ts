/**
 * 时区日期辅助（默认 Asia/Shanghai = UTC+8）。
 */

const TZ_OFFSET_MS: Record<string, number> = {
  "Asia/Shanghai": 8 * 3600_000,
  UTC: 0,
};

export function offsetMs(timezone: string): number {
  return TZ_OFFSET_MS[timezone] ?? TZ_OFFSET_MS["Asia/Shanghai"]!;
}

/** 配置时区下的日历日 YYYY-MM-DD */
export function dateKey(ms: number, timezone: string): string {
  const local = new Date(ms + offsetMs(timezone));
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 配置时区下的月份 YYYY-MM */
export function monthKey(ms: number, timezone: string): string {
  return dateKey(ms, timezone).slice(0, 7);
}

/** 配置时区当日 0 点对应的 UTC ms */
export function startOfLocalDay(ms: number, timezone: string): number {
  const off = offsetMs(timezone);
  const local = new Date(ms + off);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return startLocal - off;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}时`);
  if (m > 0) parts.push(`${m}分`);
  if (parts.length === 0 || sec > 0) parts.push(`${sec}秒`);
  return parts.join("") || "0秒";
}
