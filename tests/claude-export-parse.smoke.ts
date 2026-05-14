/**
 * Run: tsx tests/claude-export-parse.smoke.ts
 */

import assert from "node:assert/strict";

import {
  claudeConversationToRows,
  normalizeClaudeExportRoot,
  parseClaudeExport,
} from "../services/claude-export-parse.js";

const sample = [
  {
    uuid: "conv-1",
    name: "Hi",
    created_at: "2024-01-15T12:00:00.000Z",
    chat_messages: [
      {
        uuid: "m1",
        sender: "human",
        text: "hello",
        created_at: "2024-01-15T12:00:01.000Z",
      },
      {
        uuid: "m2",
        sender: "assistant",
        text: "",
        content: [{ type: "text", text: "world" }],
        created_at: "2024-01-15T12:00:02.000Z",
      },
    ],
  },
];

normalizeClaudeExportRoot(sample);
normalizeClaudeExportRoot({ conversations: sample });

assert.throws(() => normalizeClaudeExportRoot([{ title: "x" }]), /Claude-style/);

const rows = claudeConversationToRows(sample[0] as Record<string, unknown>);
assert.equal(rows.length, 2);
assert.equal(rows[0].role, "user");
assert.equal(rows[0].content, "hello");
assert.equal(rows[1].role, "assistant");
assert.ok(rows[1].content.includes("world"));

const parsed = parseClaudeExport(sample);
assert.equal(parsed.length, 1);
assert.equal(parsed[0].conversationId, "claude:conv-1");
assert.equal(parsed[0].rows.length, 2);

const toolish = {
  uuid: "c2",
  name: "Tools",
  chat_messages: [
    {
      sender: "assistant",
      text: "",
      content: [
        { type: "tool_use", name: "web_search", input: { query: "q" } },
        {
          type: "tool_result",
          name: "web_search",
          is_error: false,
          content: [{ type: "knowledge", title: "T", url: "https://example.com" }],
        },
      ],
      created_at: "2024-01-15T12:00:00.000Z",
    },
  ],
};
const tr = claudeConversationToRows(toolish as Record<string, unknown>);
assert.equal(tr.length, 1);
assert.ok(tr[0].content.includes("tool_use"));
assert.ok(tr[0].content.includes("tool_result"));

console.log("claude-export-parse smoke ok");
