/** Serialize and parse simple `KEY=value` lines for AA `userData/.env` (Electron secrets). */

/** Parse dotenv-style lines; values may be unquoted or single/double-quoted. */
export function parseDotenvLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      continue;
    }
    const eq = t.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const k = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      continue;
    }
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = unquote(v.slice(1, -1));
    }
    out[k] = v;
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/\\(.)/g, (_m, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return ch;
  });
}

/** Escape for double-quoted `.env` value — use when value has spaces or special chars. */
function quoteIfNeeded(v: string): string {
  if (v === "") {
    return '""';
  }
  if (/^[\w.~+/-]+$/.test(v)) {
    return v;
  }
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

/** Build `.env` text from env keys (only non-empty). */
export function formatDotenvSection(
  lines: Array<[string, string]>,
): string {
  const head = ["# AA secrets — Settings → Save all. Gitignore. Do not commit.", ""];
  const body = lines
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}=${quoteIfNeeded(v)}`);
  return `${head.join("\n")}${body.join("\n")}\n`;
}
