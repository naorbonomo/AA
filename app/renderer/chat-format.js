/**
 * Small markdown-ish formatter for LLM chat (fenced code, lists, inline code, emphasis).
 * Outputs HTML built only from escaped text + fixed tags (no script/on*).
 */
(function (global) {
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** @param {string} url */
  function safeHref(url) {
    const u = String(url).trim();
    if (/^https?:\/\//i.test(u)) {
      return esc(u);
    }
    return "";
  }

  /** @param {string} lang */
  function langSuffix(lang) {
    const L = String(lang)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    return L ? " msg-md__lang-" + L : "";
  }

  /**
   * Inline spans after extracting `code`, then links, then escape, then emphasis.
   * @param {string} raw unescaped segment
   */
  function formatInline(raw) {
    /** @type {string[]} */
    const codes = [];
    /** @type {string[]} */
    const links = [];
    let s = String(raw);
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codes.push('<code class="msg-md__ic">' + esc(c) + "</code>");
      return "\uE000C" + (codes.length - 1) + "\uE001";
    });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label, href) => {
      const h = safeHref(href);
      const idx = links.length;
      if (h) {
        links.push(
          '<a class="msg-md__a" href="' +
            h +
            '" target="_blank" rel="noopener noreferrer">' +
            esc(label) +
            "</a>",
        );
      } else {
        links.push(esc(full));
      }
      return "\uE000L" + idx + "\uE001";
    });
    s = esc(s);
    s = s.replace(/\uE000C(\d+)\uE001/g, (_, i) => codes[Number(i)] || "");
    s = s.replace(/\uE000L(\d+)\uE001/g, (_, i) => links[Number(i)] || "");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return s;
  }

  /**
   * One logical block (between blank lines in prose segments).
   * @param {string} block
   */
  function formatProseBlock(block) {
    const b = block.replace(/\r\n/g, "\n").trimEnd();
    if (!b.trim()) {
      return "";
    }
    const lines = b.split("\n");
    const first = lines[0].trim();
    const hm = /^(#{1,3})\s+(.+)$/.exec(first);
    if (hm && lines.length === 1) {
      const level = hm[1].length;
      const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
      return "<" + tag + ' class="msg-md__h">' + formatInline(hm[2]) + "</" + tag + ">";
    }

    const isBullet = (ln) => {
      const t = ln.trim();
      return t.length > 0 && /^[-*]\s+/.test(t);
    };
    const isNumbered = (ln) => {
      const t = ln.trim();
      return t.length > 0 && /^\d+\.\s+/.test(t);
    };

    if (lines.every((ln) => !ln.trim() || isBullet(ln))) {
      let html = '<ul class="msg-md__ul">';
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) {
          continue;
        }
        html += "<li>" + formatInline(t.replace(/^[-*]\s+/, "")) + "</li>";
      }
      html += "</ul>";
      return html;
    }

    if (lines.every((ln) => !ln.trim() || isNumbered(ln))) {
      let html = '<ol class="msg-md__ol">';
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) {
          continue;
        }
        html += "<li>" + formatInline(t.replace(/^\d+\.\s+/, "")) + "</li>";
      }
      html += "</ol>";
      return html;
    }

    const quoteLines = lines.filter((ln) => ln.trim().length > 0);
    if (
      quoteLines.length &&
      quoteLines.every((ln) => /^\s*>[\s>]?/.test(ln))
    ) {
      const inner = lines
        .map((ln) => ln.replace(/^\s*>\s?/, ""))
        .join("\n");
      return (
        '<blockquote class="msg-md__bq">' +
        formatInline(inner).replace(/\n/g, "<br />") +
        "</blockquote>"
      );
    }

    return (
      '<p class="msg-md__p">' +
      formatInline(b).replace(/\n/g, "<br />") +
      "</p>"
    );
  }

  /** @param {string} prose */
  function formatProse(prose) {
    const t = prose.replace(/\r\n/g, "\n");
    if (!t.trim()) {
      return "";
    }
    const chunks = t.split(/\n{2,}/);
    let html = "";
    for (const ch of chunks) {
      html += formatProseBlock(ch);
    }
    return html;
  }

  /**
   * @param {string} source
   * @returns {{ type: "text"|"code", lang: string, value: string }[]}
   */
  function splitFenced(source) {
    /** @type {{ type: "text"|"code", lang: string, value: string }[]} */
    const out = [];
    let rest = source;
    while (rest.length) {
      const i = rest.indexOf("```");
      if (i === -1) {
        out.push({ type: "text", lang: "", value: rest });
        break;
      }
      if (i > 0) {
        out.push({ type: "text", lang: "", value: rest.slice(0, i) });
      }
      rest = rest.slice(i + 3);
      const nl = rest.indexOf("\n");
      const lang = nl === -1 ? rest.trim() : rest.slice(0, nl).trim();
      rest = nl === -1 ? "" : rest.slice(nl + 1);
      const j = rest.indexOf("```");
      if (j === -1) {
        out.push({ type: "code", lang, value: rest });
        break;
      }
      out.push({ type: "code", lang, value: rest.slice(0, j) });
      rest = rest.slice(j + 3).replace(/^\n/, "");
    }
    return out;
  }

  /** @param {string} raw */
  function formatChatMarkdown(raw) {
    const str = String(raw);
    if (!str.trim()) {
      return "";
    }
    const segments = splitFenced(str);
    let html = "";
    for (const seg of segments) {
      if (seg.type === "code") {
        const langAttr = seg.lang ? ' data-lang="' + esc(seg.lang) + '"' : "";
        html +=
          '<pre class="msg-md__pre"' +
          langAttr +
          "><code class=\"msg-md__fence" +
          langSuffix(seg.lang) +
          '">' +
          esc(seg.value).replace(/\n+$/, "") +
          "</code></pre>";
      } else {
        html += formatProse(seg.value);
      }
    }
    return html;
  }

  global.aaChatFormat = { formatChatMarkdown };
})(typeof window !== "undefined" ? window : globalThis);
