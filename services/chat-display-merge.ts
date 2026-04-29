/** Merge app chat transcript with Telegram mirror rows for desktop UI (read-only overlay). */

import type { ChatHistoryRow } from "./chat-history-store.js";
import { readChatHistory } from "./chat-history-store.js";
import { listTelegramHistoryChatIds, readTelegramChatMirrorRowsInOrder } from "./telegram-history-store.js";

function rowTime(r: ChatHistoryRow): number {
  return typeof r.atMs === "number" && Number.isFinite(r.atMs) ? r.atMs : 0;
}

/** Group rows into Q→A chunks: each chunk starts at `user`, or is a standalone non-user prefix (scheduler, orphan assistant, system). */
function splitHistoryIntoTurns(rows: ChatHistoryRow[]): ChatHistoryRow[][] {
  const turns: ChatHistoryRow[][] = [];
  let cur: ChatHistoryRow[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      if (cur.length) {
        turns.push(cur);
        cur = [];
      }
      cur.push(row);
    } else {
      if (cur.length === 0) {
        turns.push([row]);
      } else {
        cur.push(row);
      }
    }
  }
  if (cur.length) {
    turns.push(cur);
  }
  return turns;
}

function turnSortKey(turn: ChatHistoryRow[]): number {
  const u = turn.find((r) => r.role === "user");
  if (u) {
    return rowTime(u);
  }
  let min = Infinity;
  for (const r of turn) {
    const t = rowTime(r);
    if (t < min) {
      min = t;
    }
  }
  return Number.isFinite(min) ? min : 0;
}

type TaggedTurn = { origin: 0 | 1; seq: number; turn: ChatHistoryRow[] };

/**
 * Merge desktop history with Telegram mirror: order by **turn** (user + following assistants),
 * not by every row's timestamp — avoids interleaving two users then two answers.
 * Tie on turn start time: **desktop first** (origin 0 before 1).
 */
export function readChatHistoryForDisplay(showTelegramMirror: boolean): ChatHistoryRow[] {
  const app = readChatHistory();
  if (!showTelegramMirror) {
    return app;
  }

  const tagged: TaggedTurn[] = [];
  let seq = 0;
  for (const t of splitHistoryIntoTurns(app)) {
    tagged.push({ origin: 0, seq: seq++, turn: t });
  }
  for (const chatId of listTelegramHistoryChatIds()) {
    const rows = readTelegramChatMirrorRowsInOrder(chatId);
    for (const t of splitHistoryIntoTurns(rows)) {
      tagged.push({ origin: 1, seq: seq++, turn: t });
    }
  }

  tagged.sort((a, b) => {
    const ka = turnSortKey(a.turn);
    const kb = turnSortKey(b.turn);
    if (ka !== kb) {
      return ka - kb;
    }
    if (a.origin !== b.origin) {
      return a.origin - b.origin;
    }
    return a.seq - b.seq;
  });

  const out: ChatHistoryRow[] = [];
  for (const { turn } of tagged) {
    out.push(...turn);
  }
  return out;
}
