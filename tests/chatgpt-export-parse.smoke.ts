/**
 * Run: tsx tests/chatgpt-export-parse.smoke.ts
 */

import assert from "node:assert/strict";

import { conversationExportToRows, normalizeExportRoot, parseChatgptExport } from "../services/chatgpt-export-parse.js";

const minimal = [
  {
    id: "conv-1",
    title: "Hello",
    create_time: 1_700_000_000,
    current_node: "m2",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["m1"] },
      m1: {
        id: "m1",
        message: {
          author: { role: "user" },
          content: { content_type: "text", parts: ["hi"] },
          create_time: 1_700_000_001,
        },
        parent: "root",
        children: ["m2"],
      },
      m2: {
        id: "m2",
        message: {
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["yo"] },
          create_time: 1_700_000_002,
        },
        parent: "m1",
        children: [],
      },
    },
  },
];

normalizeExportRoot(minimal);
normalizeExportRoot({ conversations: minimal });
normalizeExportRoot(minimal[0]);
normalizeExportRoot({ export: minimal });
normalizeExportRoot({ payload: { conversations: minimal } });

assert.throws(() => normalizeExportRoot([{ title: "x", id: "1" }]), /mapping/);

const rows = conversationExportToRows(minimal[0] as Record<string, unknown>);
assert.equal(rows.length, 2);
assert.equal(rows[0].role, "user");
assert.equal(rows[0].content, "hi");
assert.equal(rows[1].role, "assistant");
assert.equal(rows[1].content, "yo");

const parsed = parseChatgptExport(minimal);
assert.equal(parsed.length, 1);
assert.equal(parsed[0].conversationId, "chatgpt:conv-1");
assert.equal(parsed[0].rows.length, 2);

const toolConv = {
  title: "T",
  create_time: 1,
  current_node: "t1",
  mapping: {
    r: { id: "r", message: null, parent: null, children: ["t1"] },
    t1: {
      id: "t1",
      message: {
        author: { role: "tool" },
        content: { parts: ['{"x":1}'] },
        create_time: 2,
      },
      parent: "r",
      children: [],
    },
  },
};
const tr = conversationExportToRows(toolConv as Record<string, unknown>);
assert.equal(tr[0].role, "system");
assert.ok(tr[0].content.startsWith("[tool]\n"));

console.log("chatgpt-export-parse smoke ok");
