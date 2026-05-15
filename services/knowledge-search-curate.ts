/**
 * Mirrors context-engine flow:
 * - `ContextHandler.get_document_context` + enhanced `/ollama-embeddings/search` (multi-query + sufficiency pass)
 * - `document_chat` system prompt with excerpt bullets + `chatCompletion` for curated answer
 */

import type { EmbeddingSearchHit } from "./embedding-vector-store.js";
import { parseEnvelopeJson, searchEmbeddingCorpus } from "./conversation-embeddings.js";

export function getMultipleQueries(query: string): string[] {
  const queries = [query.trim()].filter(Boolean);
  const qLower = query.toLowerCase();

  const technicalTerms = extractTechnicalTerms(query);
  for (const term of technicalTerms) {
    if (!qLower.includes(term.toLowerCase())) {
      queries.push(`${query} ${term}`);
    }
  }

  if (/\b(how|setup|configure|install)\b/i.test(query)) {
    queries.push(`${query} procedure steps`);
    queries.push(`${query} instructions`);
  }
  if (/\b(error|problem|issue|trouble)\b/i.test(query)) {
    queries.push(`${query} troubleshooting`);
    queries.push(`${query} solution`);
  }
  if (/\b(button|knob|switch|control)\b/i.test(query)) {
    queries.push(`${query} interface`);
    queries.push(`${query} panel`);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const q of queries) {
    const k = q.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(q);
    }
  }
  return unique.length ? unique : [query];
}

function extractTechnicalTerms(query: string): string[] {
  const cap = query.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g);
  return cap ?? [];
}

export function analyzeContextSufficiency(
  contextList: string[],
  userInput: string,
): { analysis: string; additionalQueries: string[] } {
  if (!contextList.length) {
    return { analysis: "No context found", additionalQueries: [userInput] };
  }

  const queryTerms = new Set(
    userInput
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
  const contextText = contextList.join(" ").toLowerCase();

  let matchingTerms = 0;
  for (const term of queryTerms) {
    if (contextText.includes(term)) matchingTerms += 1;
  }
  const coverageRatio = queryTerms.size ? matchingTerms / queryTerms.size : 0;

  const additionalQueries: string[] = [];
  if (coverageRatio < 0.5) {
    const missing = [...queryTerms].filter((term) => !contextText.includes(term));
    if (missing.length) {
      additionalQueries.push(`${userInput} ${missing.slice(0, 3).join(" ")}`);
    }
  }

  const low = userInput.toLowerCase();
  if (/\b(how|step|procedure|setup)\b/i.test(userInput)) {
    if (!contextText.includes("step") && !contextText.includes("procedure")) {
      additionalQueries.push(`${userInput} step by step procedure`);
    }
  }

  return {
    analysis: `Context coverage: ${coverageRatio.toFixed(2)}, extra queries: ${additionalQueries.length}`,
    additionalQueries,
  };
}

function mergeHitsByBestDistance(hits: EmbeddingSearchHit[]): EmbeddingSearchHit[] {
  const m = new Map<number, EmbeddingSearchHit>();
  for (const h of hits) {
    const prev = m.get(h.rowid);
    if (!prev || h.distance < prev.distance) m.set(h.rowid, h);
  }
  return [...m.values()].sort((a, b) => a.distance - b.distance);
}

export function hitToContextString(hit: EmbeddingSearchHit): string {
  const env = parseEnvelopeJson(hit.body);
  if (env?.text && typeof env.text === "string") {
    const bits: string[] = [];
    if (env.sessionLabel) bits.push(String(env.sessionLabel));
    if (env.role) bits.push(String(env.role));
    if (env.conversationId) bits.push(`id:${env.conversationId}`);
    const head = bits.length ? `[${bits.join(" · ")}]` : "";
    return head ? `${head}\n${env.text}` : env.text;
  }
  return hit.body;
}

export async function searchKnowledgeEnhanced(opts: {
  queryText: string;
  topK: number;
  enhanced: boolean;
}): Promise<
  | {
      ok: true;
      hits: EmbeddingSearchHit[];
      queryVariations: string[];
      searchMetadata: Record<string, unknown>;
    }
  | { ok: false; error: string }
> {
  const topK = Math.min(100, Math.max(1, Math.floor(opts.topK)));

  if (!opts.enhanced) {
    const r = await searchEmbeddingCorpus({ queryText: opts.queryText, topK });
    if (!r.ok) return r;
    return {
      ok: true,
      hits: r.hits,
      queryVariations: [opts.queryText.trim()].filter(Boolean),
      searchMetadata: {
        original_query: opts.queryText,
        search_type: "basic",
        total_results: r.hits.length,
      },
    };
  }

  const queries = getMultipleQueries(opts.queryText.trim() || opts.queryText);
  let pool: EmbeddingSearchHit[] = [];

  for (const q of queries) {
    const r = await searchEmbeddingCorpus({ queryText: q, topK });
    if (!r.ok) return r;
    pool.push(...r.hits);
  }

  const mergedFirst = mergeHitsByBestDistance(pool);
  const topPool = mergedFirst.slice(0, Math.min(mergedFirst.length, topK * 2));
  const contextStrings = topPool.map(hitToContextString);
  const { analysis, additionalQueries } = analyzeContextSufficiency(contextStrings, opts.queryText.trim());

  if (additionalQueries.length) {
    for (const aq of additionalQueries) {
      const r = await searchEmbeddingCorpus({ queryText: aq, topK });
      if (!r.ok) return r;
      pool.push(...r.hits);
    }
  }

  const finalHits = mergeHitsByBestDistance(pool).slice(0, topK);

  return {
    ok: true,
    hits: finalHits,
    queryVariations: queries,
    searchMetadata: {
      original_query: opts.queryText,
      query_variations_count: queries.length,
      context_analysis: analysis,
      total_results: finalHits.length,
      search_type: "enhanced",
      extra_retrieval_queries: additionalQueries.length,
    },
  };
}

