/**
 * @sfmc-bds/module-online-time — 进服打点 + 心跳结转
 */

import { Player, system, world } from "@minecraft/server";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { Command, debug, Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { dateKey, formatDuration, monthKey, startOfLocalDay } from "./timeutil.js";
import featureUi from "./ui/feature.ui.json" with { type: "json" };
import statsUi from "./ui/screens/stats.ui.json" with { type: "json" };

const MODULE_ID = "online-time";
const TABLE = "sfmc_online_time";

interface SessionState {
  playerName: string;
  sessionStartMs: number;
  baseTodaySeconds: number;
  baseMonthSeconds: number;
  baseTotalSeconds: number;
  sessionTotalSeconds: number;
  lastDate: string;
  lastMonth: string;
}

interface DbRow {
  player_id: string;
  player_name: string;
  today_seconds: number;
  month_seconds: number;
  total_seconds: number;
  last_date: string;
  last_month: string;
  updated_at: number;
  [key: string]: unknown;
}

const sessions = new Map<string, SessionState>();
const unprovide: Array<() => void> = [];
const eventCleanups: Array<() => void> = [];
let flushRunId: number | undefined;
let timezone = "Asia/Shanghai";
let flushIntervalTicks = 3600;

function deltaSeconds(state: SessionState, now = Date.now()): number {
  return Math.max(0, Math.floor((now - state.sessionStartMs) / 1000));
}

/** 跨午夜切片：把跨日前的秒数结转到基准，sessionStart 挪到今日 0 点。 */
function applyMidnightSlice(state: SessionState, now = Date.now()): void {
  const today = dateKey(now, timezone);
  if (dateKey(state.sessionStartMs, timezone) === today) return;

  // 自 sessionStart 至今日 0 点的秒数归属「昨日」
  const todayStart = startOfLocalDay(now, timezone);
  const beforeMidnight = Math.max(0, Math.floor((todayStart - state.sessionStartMs) / 1000));
  state.baseTodaySeconds += beforeMidnight;
  state.baseMonthSeconds += beforeMidnight;
  state.baseTotalSeconds += beforeMidnight;
  state.sessionTotalSeconds += beforeMidnight;

  // 跨日：今日基准清零；跨月：本月基准清零
  const newMonth = monthKey(now, timezone);
  if (state.lastDate !== today) {
    state.baseTodaySeconds = 0;
    state.lastDate = today;
  }
  if (state.lastMonth !== newMonth) {
    state.baseMonthSeconds = 0;
    state.lastMonth = newMonth;
  }
  state.sessionStartMs = todayStart;
}

function liveSnapshot(state: SessionState, now = Date.now()) {
  applyMidnightSlice(state, now);
  const d = deltaSeconds(state, now);
  return {
    sessionSeconds: state.sessionTotalSeconds + d,
    todaySeconds: state.baseTodaySeconds + d,
    monthSeconds: state.baseMonthSeconds + d,
    totalSeconds: state.baseTotalSeconds + d,
  };
}

async function ensureRow(player: Player): Promise<DbRow> {
  const existing = await db.get<DbRow>(TABLE, player.id);
  const now = Date.now();
  const today = dateKey(now, timezone);
  const month = monthKey(now, timezone);
  if (existing) {
    let todaySec = Number(existing.today_seconds) || 0;
    let monthSec = Number(existing.month_seconds) || 0;
    const lastDate = String(existing.last_date || today);
    const lastMonth = String(existing.last_month || month);
    if (lastDate !== today) todaySec = 0;
    if (lastMonth !== month) monthSec = 0;
    return {
      player_id: player.id,
      player_name: player.name,
      today_seconds: todaySec,
      month_seconds: monthSec,
      total_seconds: Number(existing.total_seconds) || 0,
      last_date: today,
      last_month: month,
      updated_at: now,
    };
  }
  const row: DbRow = {
    player_id: player.id,
    player_name: player.name,
    today_seconds: 0,
    month_seconds: 0,
    total_seconds: 0,
    last_date: today,
    last_month: month,
    updated_at: now,
  };
  await db.tx(async (tx) => {
    await tx.insert(TABLE, row as unknown as Record<string, unknown>);
  });
  return row;
}

async function startSession(player: Player): Promise<void> {
  if (sessions.has(player.id)) return;
  const row = await ensureRow(player);
  const now = Date.now();
  sessions.set(player.id, {
    playerName: player.name,
    sessionStartMs: now,
    baseTodaySeconds: row.today_seconds,
    baseMonthSeconds: row.month_seconds,
    baseTotalSeconds: row.total_seconds,
    sessionTotalSeconds: 0,
    lastDate: row.last_date,
    lastMonth: row.last_month,
  });
}

async function flushPlayer(playerId: string, remove = false): Promise<void> {
  const state = sessions.get(playerId);
  if (!state) return;
  const now = Date.now();
  applyMidnightSlice(state, now);
  const d = deltaSeconds(state, now);
  state.baseTodaySeconds += d;
  state.baseMonthSeconds += d;
  state.baseTotalSeconds += d;
  state.sessionTotalSeconds += d;
  state.sessionStartMs = now;

  const row = {
    player_id: playerId,
    player_name: state.playerName,
    today_seconds: state.baseTodaySeconds,
    month_seconds: state.baseMonthSeconds,
    total_seconds: state.baseTotalSeconds,
    last_date: state.lastDate,
    last_month: state.lastMonth,
    updated_at: now,
  };
  try {
    await db.tx(async (tx) => {
      const existing = await tx.get(TABLE, playerId);
      if (existing) await tx.update(TABLE, playerId, row);
      else await tx.insert(TABLE, row);
    });
  } catch (err) {
    debug.e("ONLINE", `flush ${playerId}`, err instanceof Error ? err : new Error(String(err)));
  }
  if (remove) sessions.delete(playerId);
}

async function flushAll(remove = false): Promise<void> {
  const ids = [...sessions.keys()];
  for (const id of ids) await flushPlayer(id, remove);
}

async function handleByPlayer(input: Record<string, unknown>) {
  const playerId = String(input.playerId ?? "");
  if (!playerId) return null;
  const state = sessions.get(playerId);
  if (state) {
    const live = liveSnapshot(state);
    return {
      playerId,
      playerName: state.playerName,
      isOnline: true,
      sessionSeconds: live.sessionSeconds,
      todaySeconds: live.todaySeconds,
      monthSeconds: live.monthSeconds,
      totalSeconds: live.totalSeconds,
      lastActiveAt: Date.now(),
      sessionFormatted: formatDuration(live.sessionSeconds),
      todayFormatted: formatDuration(live.todaySeconds),
      monthFormatted: formatDuration(live.monthSeconds),
      totalFormatted: formatDuration(live.totalSeconds),
    };
  }
  const row = await db.get<DbRow>(TABLE, playerId);
  if (!row) {
    return {
      playerId,
      playerName: "",
      isOnline: false,
      sessionSeconds: 0,
      todaySeconds: 0,
      monthSeconds: 0,
      totalSeconds: 0,
      lastActiveAt: 0,
      sessionFormatted: formatDuration(0),
      todayFormatted: formatDuration(0),
      monthFormatted: formatDuration(0),
      totalFormatted: formatDuration(0),
    };
  }
  return {
    playerId,
    playerName: row.player_name,
    isOnline: false,
    sessionSeconds: 0,
    todaySeconds: Number(row.today_seconds) || 0,
    monthSeconds: Number(row.month_seconds) || 0,
    totalSeconds: Number(row.total_seconds) || 0,
    lastActiveAt: Number(row.updated_at) || 0,
    sessionFormatted: formatDuration(0),
    todayFormatted: formatDuration(Number(row.today_seconds) || 0),
    monthFormatted: formatDuration(Number(row.month_seconds) || 0),
    totalFormatted: formatDuration(Number(row.total_seconds) || 0),
  };
}

async function handleTop(input: Record<string, unknown>) {
  const metric = (input.metric as string) || "total";
  const limit = Math.min(50, Math.max(1, Number(input.limit) || 10));
  const field = metric === "today" ? "today_seconds" : metric === "month" ? "month_seconds" : "total_seconds";

  // 先刷在线玩家，保证榜单含实时增量
  await flushAll(false);

  const rows = await db.query<DbRow>(TABLE, {
    orderBy: { field, dir: "desc" },
    limit,
  });

  return rows.map((row, i) => {
    const seconds = Number(row[field as keyof DbRow]) || 0;
    return {
      rank: i + 1,
      playerId: row.player_id,
      playerName: row.player_name,
      seconds,
      formatted: formatDuration(seconds),
      isOnline: sessions.has(row.player_id),
    };
  });
}

async function registerUiFeature(): Promise<void> {
  const result = await service.call<{ ok?: boolean; error?: string }>("gui.registerFeature", {
    feature: featureUi,
    screens: {
      "screens/stats.ui.json": statsUi,
    },
  });
  if (!result?.ok) throw new Error(result?.error || "在线时长 UI 注册失败");
}

function registerCommands(): void {
  const handler = (player: Player | undefined) => {
    if (!player) {
      debug.i("ONLINE", "该指令必须由玩家执行");
      return;
    }
    void service
      .call("gui.openScreen", {
        playerId: player.id,
        moduleId: MODULE_ID,
        screenId: "online-time.stats",
      })
      .catch((error) => {
        debug.w("ONLINE", `打开 UI 失败: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  Command.register("online", "onlinetime.see", handler, "查看在线时间统计", MODULE_ID);
}

registerCommands();

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("onlinetime.see", Permission.Any);
    },
    registerEvents() {
      const spawnCb = world.afterEvents.playerSpawn.subscribe((ev) => {
        if (ev.initialSpawn) void startSession(ev.player);
      });
      eventCleanups.push(() => {
        try {
          world.afterEvents.playerSpawn.unsubscribe(spawnCb);
        } catch {
          /* ignore */
        }
      });

      const leaveCb = world.afterEvents.playerLeave.subscribe((ev) => {
        void flushPlayer(ev.playerId, true);
      });
      eventCleanups.push(() => {
        try {
          world.afterEvents.playerLeave.unsubscribe(leaveCb);
        } catch {
          /* ignore */
        }
      });
    },
    async init() {
      const tz = await config.get<string>("timezone");
      const interval = await config.get<number>("flush_interval_ticks");
      if (typeof tz === "string" && tz) timezone = tz;
      if (typeof interval === "number" && interval > 0) flushIntervalTicks = interval;

      await db.defineTable(TABLE, {
        player_id: { type: "TEXT", primary: true },
        player_name: { type: "TEXT", default: "" },
        today_seconds: { type: "INTEGER", default: 0, index: true },
        month_seconds: { type: "INTEGER", default: 0 },
        total_seconds: { type: "INTEGER", default: 0, index: true },
        last_date: { type: "TEXT", default: "" },
        last_month: { type: "TEXT", default: "" },
        updated_at: { type: "INTEGER", default: 0 },
      });

      for (const p of world.getAllPlayers()) void startSession(p);

      flushRunId = system.runInterval(() => void flushAll(false), flushIntervalTicks);

      unprovide.push(service.provide("onlinetime.byPlayer", (input) => handleByPlayer(input)));
      unprovide.push(service.provide("onlinetime.top", (input) => handleTop(input)));

      await registerUiFeature();
      debug.i("ONLINE", `init tz=${timezone} flush=${flushIntervalTicks}`);
    },
    cleanup() {
      void service.call("gui.unregisterFeature", { moduleId: MODULE_ID }).catch(() => undefined);
      for (const off of unprovide.splice(0, unprovide.length)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      for (const c of eventCleanups.splice(0, eventCleanups.length)) c();
      if (flushRunId !== undefined) {
        try {
          system.clearRun(flushRunId);
        } catch {
          /* ignore */
        }
        flushRunId = undefined;
      }
      void flushAll(true);
      debug.i("ONLINE", "cleanup");
    },
  },
});
