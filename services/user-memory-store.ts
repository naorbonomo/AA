/** Local SQLite store for extracted user facts + embedding vectors as JSON (same dim as Settings → Embeddings). */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { getEmbeddingVectorDimension } from "./embedding-vector-store.js";
import { createEmbeddings } from "./embeddings.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("user-memory-store");

const TABLE = "user_facts";

export const USER_FACT_CATEGORIES = [
  "identity",
  "preference",
  "behavior",
  "goal",
  "relationship",
  "context",
] as const;

export type UserFactCategory = (typeof USER_FACT_CATEGORIES)[number];

export type StoredUserFact = {
  id: number;
  key: string;
  value: string;
  confidence: number;
  category: UserFactCategory;
  source_turn_id: string;
  embedding_json: string;
  updated_at_ms: number;
  created_at_ms: number;
};

export type UpsertFactInput = {
  key: string;
  value: string;
  confidence: number;
  category: string;
  source_turn_id: string;
};

let storeUserDataDir: string | null = null;
let db: Database.Database | null = null;

function aaRootFromCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

export function getUserMemoryDbPath(): string {
  if (storeUserDataDir) {
    return path.join(storeUserDataDir, "aa-user-memory.sqlite");
  }
  return path.join(aaRootFromCwd(), "aa-user-memory.sqlite");
}

export function initializeUserMemoryStore(opts?: { userDataDir?: string }): void {
  if (opts?.userDataDir?.trim()) {
    storeUserDataDir = opts.userDataDir.trim();
  }
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
  const filePath = getUserMemoryDbPath();
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  const conn = new Database(filePath);
  conn.pragma("journal_mode = WAL");
  const cats = USER_FACT_CATEGORIES.map((c) => `'${c}'`).join(", ");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL,
      category TEXT NOT NULL CHECK(category IN (${cats})),
      source_turn_id TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_facts_category ON ${TABLE}(category);
    CREATE INDEX IF NOT EXISTS idx_user_facts_confidence ON ${TABLE}(confidence DESC);
  `);
  db = conn;
}

function ensureDb(): Database.Database {
  if (!db) {
    initializeUserMemoryStore();
  }
  if (!db) {
    throw new Error("user memory store failed to open");
  }
  return db;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return -1;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

const SIM_MERGE_THRESHOLD = 0.92;

export function normalizeFactCategory(raw: string): UserFactCategory | null {
  const s = raw.trim().toLowerCase();
  for (const c of USER_FACT_CATEGORIES) {
    if (s === c) return c;
  }
  return null;
}

/** Rough snake_case normalize for keys from LLM. */
export function normalizeFactKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 256);
}

function embeddingVecFromJson(jsonStr: string): number[] | null {
  try {
    const arr = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(arr)) return null;
    const out: number[] = [];
    for (const x of arr) {
      if (typeof x !== "number" || !Number.isFinite(x)) return null;
      out.push(x);
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export function listFacts(): StoredUserFact[] {
  const conn = ensureDb();
  const rows = conn
    .prepare(
      `SELECT id, key, value, confidence, category, source_turn_id, embedding_json, updated_at_ms, created_at_ms
       FROM ${TABLE} ORDER BY confidence DESC, updated_at_ms DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const out: StoredUserFact[] = [];
  for (const r of rows) {
    const cat = normalizeFactCategory(String(r.category ?? ""));
    if (!cat) continue;
    out.push({
      id: Number(r.id),
      key: String(r.key ?? ""),
      value: String(r.value ?? ""),
      confidence: Number(r.confidence),
      category: cat,
      source_turn_id: String(r.source_turn_id ?? ""),
      embedding_json: String(r.embedding_json ?? ""),
      updated_at_ms: Number(r.updated_at_ms),
      created_at_ms: Number(r.created_at_ms),
    });
  }
  return out;
}

export function getFactsForProfile(): StoredUserFact[] {
  return listFacts();
}

export async function updateFactById(
  id: number,
  patch: { key?: string; value?: string; confidence?: number; category?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const conn = ensureDb();
    const row = conn.prepare(`SELECT key, value, confidence, category FROM ${TABLE} WHERE id = ?`).get(id) as
      | { key: string; value: string; confidence: number; category: string }
      | undefined;
    if (!row) {
      return { ok: false, error: "fact not found" };
    }
    const nextKey = patch.key !== undefined ? normalizeFactKey(patch.key) : row.key;
    const nextVal = patch.value !== undefined ? patch.value.trim().slice(0, 500_000) : row.value;
    let nextConf =
      patch.confidence !== undefined && Number.isFinite(patch.confidence)
        ? patch.confidence
        : Number(row.confidence);
    nextConf = Math.min(1, Math.max(0, nextConf));
    const catRaw = patch.category !== undefined ? patch.category : row.category;
    const nextCat = normalizeFactCategory(catRaw);
    if (!nextKey.length) {
      return { ok: false, error: "key empty" };
    }
    if (!nextCat) {
      return { ok: false, error: "invalid category" };
    }
    const embInput = `${nextKey}\n${nextVal}`;
    const res = await createEmbeddings({ input: embInput });
    const vec = res.embeddings[0];
    const dim = getEmbeddingVectorDimension();
    if (!vec || vec.length !== dim) {
      return { ok: false, error: `embedding dim mismatch (got ${vec?.length}, need ${dim})` };
    }
    const now = Date.now();
    conn
      .prepare(
        `UPDATE ${TABLE}
         SET key = ?, value = ?, confidence = ?, category = ?, embedding_json = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(nextKey, nextVal, nextConf, nextCat, JSON.stringify(vec), now, id);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export function deleteFact(id: number): boolean {
  const conn = ensureDb();
  const r = conn.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
  return r.changes > 0;
}

export function clearAllFacts(): void {
  ensureDb().exec(`DELETE FROM ${TABLE}`);
}

/** Embed key + newline + value; cosine-merge within category when similarity > 0.92 (keep higher-confidence wording). */
export async function upsertFactWithDedup(input: UpsertFactInput): Promise<{ id: number; merged: boolean } | null> {
  const category = normalizeFactCategory(input.category);
  if (!category) {
    log.warn("upsertFactWithDedup: bad category", { raw: input.category });
    return null;
  }
  const key = normalizeFactKey(input.key);
  const value = input.value.trim().slice(0, 500_000);
  if (!key.length || !value.length) {
    return null;
  }
  let confidence = Number(input.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  const conn = ensureDb();
  const embInput = `${key}\n${value}`;
  let vec: number[];
  try {
    const res = await createEmbeddings({ input: embInput });
    vec = res.embeddings[0];
  } catch (e) {
    log.warn("upsertFactWithDedup embed failed", { msg: e instanceof Error ? e.message : String(e) });
    return null;
  }
  const dim = getEmbeddingVectorDimension();
  if (!vec || vec.length !== dim) {
    log.warn("upsertFactWithDedup dim mismatch", { got: vec?.length, dim });
    return null;
  }

  const peers = conn
    .prepare(`SELECT id, key, value, confidence, embedding_json FROM ${TABLE} WHERE category = ?`)
    .all(category) as Array<{
      id: number;
      key: string;
      value: string;
      confidence: number;
      embedding_json: string;
    }>;

  let bestId: number | null = null;
  let bestSim = -1;
  for (const p of peers) {
    const oldVec = embeddingVecFromJson(p.embedding_json);
    if (!oldVec || oldVec.length !== vec.length) continue;
    const sim = cosineSimilarity(vec, oldVec);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = p.id;
    }
  }

  const now = Date.now();

  if (bestSim >= SIM_MERGE_THRESHOLD && bestId !== null) {
    const existing = peers.find((p) => p.id === bestId);
    if (existing) {
      const existingConf = Number(existing.confidence);
      const keepNew = confidence > existingConf;
      const mergedKey = keepNew ? key : normalizeFactKey(existing.key);
      const mergedVal = keepNew ? value : existing.value.trim();
      const mergedConf = Math.max(confidence, existingConf);
      const mergedEmbInput = `${mergedKey}\n${mergedVal}`;
      let mergedVec = vec;
      try {
        const r2 = await createEmbeddings({ input: mergedEmbInput });
        mergedVec = r2.embeddings[0];
      } catch {
        mergedVec = vec;
      }
      conn
        .prepare(
          `UPDATE ${TABLE}
           SET key = ?, value = ?, confidence = ?, source_turn_id = ?, embedding_json = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(
          mergedKey,
          mergedVal,
          mergedConf,
          input.source_turn_id.trim().slice(0, 2048),
          JSON.stringify(mergedVec),
          now,
          bestId,
        );
      return { id: bestId, merged: true };
    }
  }

  const ins = conn.prepare(
    `INSERT INTO ${TABLE}
      (key, value, confidence, category, source_turn_id, embedding_json, updated_at_ms, created_at_ms)
     VALUES (@key, @value, @confidence, @category, @source_turn_id, @embedding_json, @updated_at_ms, @created_at_ms)`,
  );
  const info = ins.run({
    key,
    value,
    confidence,
    category,
    source_turn_id: input.source_turn_id.trim().slice(0, 2048),
    embedding_json: JSON.stringify(vec),
    updated_at_ms: now,
    created_at_ms: now,
  });
  return { id: Number(info.lastInsertRowid), merged: false };
}