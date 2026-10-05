import type { ReactNode } from "react";
import { CopyButton } from "@/components/integrate/copy-button";
import { cn } from "@/lib/utils";

type Lang = "solidity" | "ts" | "json" | "bash" | "html";

const KEYWORDS: Record<Lang, readonly string[]> = {
  solidity: ["interface", "abstract", "contract", "function", "external", "internal", "view", "returns", "public", "immutable", "constant", "error", "constructor", "if", "revert", "uint256", "uint80", "int256", "address", "return"],
  ts: ["import", "from", "const", "await", "new", "export", "return"],
  json: [],
  bash: ["curl"],
  html: [],
};

/**
 * Tiny tokenizer: comments, strings, numbers, keywords. Enough to read code on a projector
 * without a highlighting dependency.
 */
function highlight(code: string, lang: Lang): ReactNode[] {
  const kw = KEYWORDS[lang];
  const re = /(\/\/[^\n]*|#[^\n]*(?=\n|$)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d[\d_]*\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of code.matchAll(re)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(code.slice(last, at));
    let cls: string | null = null;
    if (tok.startsWith("//") || (lang === "bash" && tok.startsWith("#"))) cls = "text-subtle italic";
    else if (tok.startsWith("#")) cls = null;
    else if (tok.startsWith('"') || tok.startsWith("'")) cls = lang === "json" && code[at + tok.length] === ":" ? "text-recovering" : "text-conserved";
    else if (/^\d/.test(tok)) cls = "text-drift";
    else if (kw.includes(tok)) cls = "text-quarantined";
    else if (/^[A-Z]/.test(tok) && lang !== "json") cls = "text-fg font-medium";
    out.push(cls ? (
      <span key={i++} className={cls}>
        {tok}
      </span>
    ) : (
      tok
    ));
    last = at + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CodeBlock({ code, lang, title, testId, className }: { code: string; lang: Lang; title: string; testId?: string; className?: string }) {
  return (
    <figure className={cn("overflow-hidden rounded-lg border border-wire bg-inset shadow-[inset_0_1px_0_0_rgb(255_255_255/0.03),0_1px_2px_rgb(0_0_0/0.2)]", className)} data-testid={testId}>
      <figcaption className="flex h-10 items-center gap-3 border-b border-wire bg-panel/60 pl-3.5 pr-2">
        <span className="flex gap-1" aria-hidden="true">
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted">{title}</span>
        <CopyButton value={code} label={title} className="ml-auto" />
      </figcaption>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] text-muted" tabIndex={0} aria-label={title}>
        <code>{highlight(code, lang)}</code>
      </pre>
    </figure>
  );
}
