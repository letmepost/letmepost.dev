/**
 * Tiny server-side tokenizer for code samples on the marketing site.
 * Produces HTML with the receipt design's `tok-*` span classes so the
 * rendered code matches the design HTML 1:1.
 *
 *   tok-k → keywords (import, const, await, curl, -X, …)
 *   tok-s → strings
 *   tok-c → comments
 *   tok-n → numbers + a handful of well-known identifiers
 *   tok-p → URLs / paths
 *
 * Not a full lexer — these are landing-page code samples, not an IDE.
 * Returns a string of HTML to render via `set:html` on a <pre>.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type TokClass = "tok-k" | "tok-s" | "tok-c" | "tok-n" | "tok-p";
type Placeholder = { cls: TokClass; text: string };

/**
 * Replace each match in `src` with a `␟N␞` placeholder (US + RS, ASCII
 * bytes 0x1F + 0x1E) and stash the original text. After all passes,
 * HTML-escape the result and swap placeholders for wrapped spans.
 *
 * The placeholder bytes are deliberately ones our hand-written code
 * samples never contain.
 */
function tokenize(
  src: string,
  patterns: Array<{ cls: TokClass; re: RegExp }>,
): string {
  const stash: Placeholder[] = [];
  let body = src;
  const open = "";
  const close = "";

  for (const { cls, re } of patterns) {
    body = body.replace(re, (match) => {
      const idx = stash.length;
      stash.push({ cls, text: match });
      // `\x1Fx<N>\x1E` — the `x` prefix means later passes' `\b\d+\b`
      // (number regex) won't match the index digits, because there's
      // no word boundary between the `x` and the digits.
      return open + "x" + idx + close;
    });
  }

  const placeholder = new RegExp(`${open}x(\\d+)${close}`, "g");
  return escapeHtml(body).replace(placeholder, (_, idxStr: string) => {
    const idx = parseInt(idxStr, 10);
    const { cls, text } = stash[idx];
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
  });
}

export function highlightTs(code: string): string {
  return tokenize(code, [
    // Comments first so they swallow keyword-looking text inside.
    { cls: "tok-c", re: /\/\*[\s\S]*?\*\//g },
    { cls: "tok-c", re: /\/\/.*$/gm },
    // Strings — single, double, template literal.
    { cls: "tok-s", re: /'(?:[^'\\]|\\.)*'/g },
    { cls: "tok-s", re: /"(?:[^"\\]|\\.)*"/g },
    { cls: "tok-s", re: /`(?:[^`\\]|\\.)*`/g },
    // URLs / paths
    { cls: "tok-p", re: /https?:\/\/[^\s'")]+/g },
    {
      cls: "tok-k",
      re: /\b(import|from|export|const|let|var|function|return|await|async|for|of|in|if|else|new|class|interface|type|typeof|extends|implements|public|private|protected|static|true|false|null|undefined|void|throw|try|catch|finally)\b/g,
    },
    { cls: "tok-n", re: /\b\d+(?:\.\d+)?\b/g },
    { cls: "tok-n", re: /\b(console|process|Date|Math|JSON|Promise|globalThis|window|document)\b/g },
  ]);
}

export function highlightJson(code: string): string {
  return tokenize(code, [
    { cls: "tok-c", re: /\/\/.*$/gm },
    { cls: "tok-s", re: /"(?:[^"\\]|\\.)*"/g },
    { cls: "tok-p", re: /https?:\/\/[^\s"]+/g },
    { cls: "tok-k", re: /\b(true|false|null)\b/g },
    { cls: "tok-n", re: /-?\b\d+(?:\.\d+)?\b/g },
  ]);
}

export function highlightBash(code: string): string {
  return tokenize(code, [
    // `#` line comments — but only at the start of a line so a `#tag`
    // inside a string body doesn't accidentally swallow the rest.
    { cls: "tok-c", re: /^#.*$/gm },
    { cls: "tok-s", re: /'(?:[^'\\]|\\.)*'/g },
    { cls: "tok-s", re: /"(?:[^"\\]|\\.)*"/g },
    { cls: "tok-p", re: /https?:\/\/\S+/g },
    { cls: "tok-k", re: /\bcurl\b/g },
    { cls: "tok-k", re: /(?<=\s|^)-[A-Za-z]+\b/g },
    { cls: "tok-n", re: /\$\(?[A-Za-z_]\w*\)?/g },
  ]);
}

export function highlightPython(code: string): string {
  return tokenize(code, [
    { cls: "tok-c", re: /#.*$/gm },
    { cls: "tok-s", re: /'(?:[^'\\]|\\.)*'/g },
    { cls: "tok-s", re: /"(?:[^"\\]|\\.)*"/g },
    { cls: "tok-p", re: /https?:\/\/[^\s'")]+/g },
    {
      cls: "tok-k",
      re: /\b(from|import|as|def|class|return|for|in|if|elif|else|while|with|try|except|finally|raise|True|False|None|and|or|not|is|lambda|async|await)\b/g,
    },
    { cls: "tok-n", re: /\b\d+(?:\.\d+)?\b/g },
    { cls: "tok-n", re: /\b(print|len|range|enumerate|zip|os|sys)\b/g },
  ]);
}

export function highlight(lang: string, code: string): string {
  switch (lang) {
    case "ts":
    case "typescript":
    case "js":
    case "javascript":
      return highlightTs(code);
    case "json":
      return highlightJson(code);
    case "bash":
    case "sh":
    case "shell":
    case "curl":
      return highlightBash(code);
    case "py":
    case "python":
      return highlightPython(code);
    default:
      return escapeHtml(code);
  }
}
