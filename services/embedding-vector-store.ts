/** sqlite-vec `vec0` store: text + embedding rows; path mirrors chat/settings (`userData` or repo cwd). */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { EMBEDDING_DEFAULT_VEC_DIMENSION } from "../config/embedding_config.js";
import { getLogger } from "../utils/logger.js";

import { getResolvedSettings } from "./settings-store.js";

const log = getLogger("embedding-vector-store");

const META_TABLE = "aa_embedding_store_meta";
const VEC_TABLE = "aa_embedding_chunks";

let storeUserDataDir: string | null = null;
let db: Database.Database | null = null;
let vecDim = EMBEDDING_DEFAULT_VEC_DIMENSION;
let insertStmt: Database.Statement | null = null;
/** Set when last `initializeEmbeddingVectorStore` failed (native load, dim mismatch, etc.). */
let lastEmbeddingStoreError: string | null = null;

/** True after successful `initializeEmbeddingVectorStore` for this process. */
export function isEmbeddingVectorStoreReady(): boolean {
  return db !== null && insertStmt !== null;
}

export function getEmbeddingVectorStoreInitError(): string | null {
  return lastEmbeddingStoreError;
}

/**
 * Open store if needed. Preserves existing `userDataDir` when opts omit it (retries after startup failure).
 * Prefer passing `userDataDir` from Electron `app.getPath("userData")` once.
 */
export function ensureEmbeddingVectorStoreOpened(opts?: {
  userDataDir?: string;
}): { ok: true } | { ok: false; error: string } {
  if (isEmbeddingVectorStoreReady()) return { ok: true };
  initializeEmbeddingVectorStore(opts);
  if (isEmbeddingVectorStoreReady()) return { ok: true };
  return {
    ok: false,
    error:
      lastEmbeddingStoreError ??
      "Embedding vector store unavailable (sqlite / sqlite-vec failed — try `npm run rebuild:electron`).",
  };
}

function aaRootFromCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

function resolvedVecDimension(): number {
  const raw = process.env.AA_EMBEDDING_VEC_DIM?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`AA_EMBEDDING_VEC_DIM invalid: ${JSON.stringify(raw)}`);
    }
    return n;
  }
  return getResolvedSettings().embedding.vecDimension;
}

export function getEmbeddingDbFilePath(): string {
  if (storeUserDataDir) {
    return path.join(storeUserDataDir, "aa-embeddings.sqlite");
  }
  return path.join(aaRootFromCwd(), "aa-embeddings.sqlite");
}

/** Active `float[N]` width for `vec0` (env overrides Settings at init). */
export function getEmbeddingVectorDimension(): number {
  return vecDim;
}

export function initializeEmbeddingVectorStore(opts?: { userDataDir?: string }): void {
  lastEmbeddingStoreError = null;
  if (opts?.userDataDir?.trim()) {
    storeUserDataDir = opts.userDataDir.trim();
  }
  vecDim = resolvedVecDimension();
  closeEmbeddingVectorStore();

  let conn: Database.Database | null = null;
  try {
    const filePath = getEmbeddingDbFilePath();
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* exists */
    }

    conn = new Database(filePath);
    conn.pragma("journal_mode = WAL");
    sqliteVec.load(conn);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS ${META_TABLE} (
        k TEXT PRIMARY KEY NOT NULL,
        v TEXT NOT NULL
      );
    `);

    const dimRow = conn
      .prepare(`SELECT v FROM ${META_TABLE} WHERE k = 'embedding_dim'`)
      .get() as { v: string } | undefined;

    if (!dimRow) {
      conn.exec(`
        CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
          embedding float[${vecDim}],
          +body text
        );
      `);
      conn.prepare(`INSERT INTO ${META_TABLE}(k, v) VALUES ('embedding_dim', ?)`).run(String(vecDim));
      log.info("created vec store", { filePath, vecDim });
    } else {
      const stored = Number.parseInt(dimRow.v, 10);
      if (!Number.isFinite(stored) || stored !== vecDim) {
        conn.close();
        conn = null;
        throw new Error(
          `Embedding DB dimension mismatch: file has ${stored}, runtime wants ${vecDim}. Delete ${filePath} or change Embeddings → vector dimension / AA_EMBEDDING_VEC_DIM to match, then restart.`,
        );
      }
      log.info("opened vec store", { filePath, vecDim });
    }

    insertStmt = conn.prepare(`INSERT INTO ${VEC_TABLE}(rowid, embedding, body) VALUES (?, ?, ?)`);
    db = conn;
    conn = null;
  } catch (e) {
    lastEmbeddingStoreError = e instanceof Error ? e.message : String(e);
    log.error("initializeEmbeddingVectorStore failed", e);
    insertStmt = null;
    db = null;
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export function closeEmbeddingVectorStore(): void {
  insertStmt = null;
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

function ensureDb(): Database.Database {
  if (!db || !insertStmt) {
    initializeEmbeddingVectorStore({});
  }
  if (!db || !insertStmt) {
    throw new Error(lastEmbeddingStoreError ?? "embedding vector store not open");
  }
  return db;
}

function floatVectorFromSqlValue(v: unknown): number[] | null {
  if (v == null) return null;
  if (v instanceof Float32Array) {
    return Array.from(v);
  }
  if (v instanceof Uint8Array) {
    const buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    return Array.from(new Float32Array(buf));
  }
  if (Buffer.isBuffer(v)) {
    return Array.from(new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4));
  }
  return null;
}

export type StoredEmbeddingRow = {
  rowid: number;
  body: string;
  embedding: number[];
};

/** Allocate next `rowid`, insert `body` + vector (length must equal `getEmbeddingVectorDimension()`). */
export function saveEmbeddingText(body: string, embedding: number[]): number {
  const conn = ensureDb();
  if (typeof body !== "string") {
    throw new Error("saveEmbeddingText: body must be string");
  }
  if (body.length === 0) {
    throw new Error("saveEmbeddingText: empty body");
  }
  if (!Array.isArray(embedding) || embedding.length !== vecDim) {
    throw new Error(`saveEmbeddingText: expected embedding length ${vecDim}, got ${embedding?.length ?? "?"}`);
  }
  const vec = new Float32Array(embedding);

  const rowid = conn.transaction(() => {
    const maxRow = conn.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${VEC_TABLE}`).get() as {
      m: number | bigint;
    };
    const next = BigInt(maxRow.m) + 1n;
    insertStmt!.run(next, vec, body);
    return Number(next);
  })();

  return rowid;
}

/** Full round-trip: auxiliary text + embedding blob. */
export function loadEmbeddingRow(rowid: number): StoredEmbeddingRow | null {
  const conn = ensureDb();
  if (!Number.isFinite(rowid) || rowid <= 0) {
    throw new Error("loadEmbeddingRow: invalid rowid");
  }
  const row = conn
    .prepare(`SELECT rowid, body, embedding FROM ${VEC_TABLE} WHERE rowid = ?`)
    .get(rowid) as { rowid: unknown; body: unknown; embedding: unknown } | undefined;
  if (!row || typeof row.body !== "string") {
    return null;
  }
  const emb = floatVectorFromSqlValue(row.embedding);
  if (!emb || emb.length !== vecDim) {
    return null;
  }
  return { rowid: Number(row.rowid), body: row.body, embedding: emb };
}

/** List rows without loading vectors (cheap browse). */
export function listEmbeddingBodies(limit = 100): Array<{ rowid: number; body: string }> {
  const conn = ensureDb();
  const lim = Math.min(Math.max(Math.floor(limit), 1), 10_000);
  const rows = conn
    .prepare(`SELECT rowid, body FROM ${VEC_TABLE} ORDER BY rowid DESC LIMIT ?`)
    .all(lim) as Array<{ rowid: unknown; body: unknown }>;
  const out: Array<{ rowid: number; body: string }> = [];
  for (const r of rows) {
    if (typeof r.body === "string") {
      out.push({ rowid: Number(r.rowid), body: r.body });
    }
  }
  return out;
}

export type EmbeddingSearchHit = {
  rowid: number;
  body: string;
  distance: number;
};

/**
 * sqlite-vec KNN on `embedding` column (default L2 distance).
 * `queryEmbedding` length must match `getEmbeddingVectorDimension()`.
 */
export function searchEmbeddingSimilar(
  queryEmbedding: number[] | Float32Array,
  k: number,
): EmbeddingSearchHit[] {
  const conn = ensureDb();
  const kk = Math.min(Math.max(Math.floor(k), 1), 500);
  const raw =
    queryEmbedding instanceof Float32Array ? queryEmbedding : Float32Array.from(queryEmbedding);
  if (raw.length !== vecDim) {
    throw new Error(`searchEmbeddingSimilar: expected length ${vecDim}, got ${raw.length}`);
  }
  const stmt = conn.prepare(
    `SELECT rowid, body, distance FROM ${VEC_TABLE} WHERE embedding MATCH ? AND k = ?`,
  );
  const rows = stmt.all(raw, kk) as Array<{
    rowid: unknown;
    body: unknown;
    distance: unknown;
  }>;
  const out: EmbeddingSearchHit[] = [];
  for (const r of rows) {
    if (typeof r.body !== "string") continue;
    const dist = typeof r.distance === "number" ? r.distance : Number(r.distance);
    if (!Number.isFinite(dist)) continue;
    out.push({ rowid: Number(r.rowid), body: r.body, distance: dist });
  }
  return out;
}
