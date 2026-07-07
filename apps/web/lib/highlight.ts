function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type TokClass = "tok-k" | "tok-s" | "tok-c" | "tok-n" | "tok-p";
type Placeholder = { cls: TokClass; text: string };

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
    { cls: "tok-c", re: /\/\*[\s\S]*?\*\//g },
    { cls: "tok-c", re: /\/\/.*$/gm },
    { cls: "tok-s", re: /'(?:[^'\\]|\\.)*'/g },
    { cls: "tok-s", re: /"(?:[^"\\]|\\.)*"/g },
    { cls: "tok-s", re: /`(?:[^`\\]|\\.)*`/g },
    { cls: "tok-p", re: /https?:\/\/[^\s'")]+/g },
    {
      cls: "tok-k",
      re: /\b(import|from|export|const|let|var|function|return|await|async|for|of|in|if|else|new|class|interface|type|typeof|extends|implements|public|private|protected|static|true|false|null|undefined|void|throw|try|catch|finally)\b/g,
    },
    { cls: "tok-n", re: /\b\d+(?:\.\d+)?\b/g },
    {
      cls: "tok-n",
      re: /\b(console|process|Date|Math|JSON|Promise|globalThis|window|document)\b/g,
    },
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
