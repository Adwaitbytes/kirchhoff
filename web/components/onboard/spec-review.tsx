"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BeforeMount, OnMount } from "@monaco-editor/react";
import { ArrowUpRight, CircleAlert, FileCheck2, PenLine, ShieldCheck } from "lucide-react";
import type { LineProvenance } from "@/lib/api/types";
import { usePrefs } from "@/lib/prefs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { Draft, Validation } from "@/components/onboard/model";
import { chipLabel, computeLines, formatLineList, missingLines, type LineState } from "@/components/onboard/provenance";
import { cn } from "@/lib/utils";

const LINE_H = 20;

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
});

type CodeEditor = Parameters<OnMount>[0];
type Decorations = ReturnType<CodeEditor["createDecorationsCollection"]>;

/** Decoration classes live here because Monaco renders outside our Tailwind tree. */
const EDITOR_CSS = `
.kh-line-missing { background: color-mix(in oklab, var(--status-broken) 14%, transparent); box-shadow: inset 2px 0 0 var(--status-broken); }
.kh-glyph { margin-left: 7px; width: 6px !important; height: 6px !important; margin-top: 7px; border-radius: 999px; }
.kh-glyph-missing { background: var(--status-broken); box-shadow: 0 0 8px var(--status-broken); }
.kh-glyph-ok { background: var(--status-conserved); opacity: 0.85; }
.kh-glyph-schema { background: var(--fg-subtle); opacity: 0.6; }
.kh-glyph-issuer { background: var(--status-drift); }
`;

const beforeMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("kh-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "type", foreground: "7DD3FC" },
      { token: "string", foreground: "A7F3D0" },
      { token: "number", foreground: "FBBF24" },
      { token: "keyword", foreground: "C4B5FD" },
      { token: "comment", foreground: "7D8693", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#0E1115",
      "editor.foreground": "#E7EAEE",
      "editorLineNumber.foreground": "#5F6773",
      "editorLineNumber.activeForeground": "#E7EAEE",
      "editor.lineHighlightBackground": "#181C22",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#2DD4BF33",
      "editorCursor.foreground": "#2DD4BF",
      "editorGutter.background": "#0E1115",
      "editorIndentGuide.background1": "#2A313B",
      "scrollbarSlider.background": "#3A435066",
    },
  });
  monaco.editor.defineTheme("kh-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "type", foreground: "0369A1" },
      { token: "string", foreground: "0F766E" },
      { token: "number", foreground: "B45309" },
      { token: "keyword", foreground: "6D28D9" },
      { token: "comment", foreground: "5F6773", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#F5F5F4",
      "editor.foreground": "#0B0D10",
      "editorLineNumber.foreground": "#6B7280",
      "editorLineNumber.activeForeground": "#0B0D10",
      "editor.lineHighlightBackground": "#ECECEA",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#0F766E26",
      "editorCursor.foreground": "#0F766E",
      "editorGutter.background": "#F5F5F4",
    },
  });
};

const CHIP: Record<LineState["status"], string> = {
  ok: "border-conserved/40 bg-conserved/10 text-conserved",
  issuer: "border-drift/40 bg-drift/10 text-drift",
  missing: "border-broken/60 bg-broken/15 text-broken",
  blank: "",
};

function chipClass(l: LineState): string {
  if (l.status === "ok" && l.provenance?.kind === "schema") return "border-wire bg-raised text-subtle";
  return CHIP[l.status];
}

function ProvenanceChip({ l, interactive }: { l: LineState; interactive: boolean }) {
  const cls = cn("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] border px-1.5 font-mono text-[10.5px] leading-none", chipClass(l));
  const label = chipLabel(l.provenance);
  if (l.provenance?.href) {
    return (
      <a href={l.provenance.href} target="_blank" rel="noopener noreferrer" tabIndex={interactive ? 0 : -1} className={cn(cls, "hover:brightness-125")} title={`Evidence for line ${l.line}`}>
        {label}
        <ArrowUpRight className="size-2.5" aria-hidden="true" />
      </a>
    );
  }
  return <span className={cls}>{label}</span>;
}

function LineEvidence({ l }: { l: LineState | undefined }) {
  if (!l || l.status === "blank") {
    return <p className="text-sm text-muted">Put the cursor on a line to see where its value came from.</p>;
  }
  const p: LineProvenance | null = l.provenance;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-subtle tnum">L{l.line}</span>
        <ProvenanceChip l={l} interactive />
      </div>
      <pre tabIndex={0} className="overflow-x-auto rounded-md bg-inset px-2.5 py-1.5 font-mono text-xs text-fg">{l.text.trim()}</pre>
      <p className="text-sm text-muted">
        {l.status === "missing"
          ? "No tool result backs this line. It cannot be approved as is. Edit it or remove it."
          : p?.kind === "issuer"
            ? "Typed by the issuer. Your edit, your signature."
            : p?.kind === "schema"
              ? "Structural line required by the KIRCH-SPEC schema."
              : `From ${p?.tool ?? "a tool"} (${p?.toolCallId ?? "trace"}).`}
      </p>
      {p?.why ? <p className="rounded-md border-l-2 border-conserved/60 bg-conserved/5 px-3 py-2 text-sm text-fg">{p.why}</p> : null}
    </div>
  );
}

export function SpecReview({
  draft,
  yaml,
  onYamlChange,
  validation,
  onApprove,
  approveBlock = null,
  children,
}: {
  draft: Draft;
  yaml: string;
  onYamlChange: (v: string) => void;
  validation: Validation | null;
  onApprove: () => void;
  /** Extra reason approval is blocked (a failing or pending backtest). */
  approveBlock?: string | null;
  /** Rendered between the editor and the approve bar (auto backtest, Scout). */
  children?: ReactNode;
}) {
  const { theme } = usePrefs();
  const lines = useMemo(() => computeLines(yaml, draft.lines), [yaml, draft.lines]);
  const missing = useMemo(() => missingLines(lines), [lines]);
  const [scrollTop, setScrollTop] = useState(0);
  const [cursor, setCursor] = useState(1);
  const [mounted, setMounted] = useState(false);
  const editorRef = useRef<CodeEditor | null>(null);
  const decoRef = useRef<Decorations | null>(null);
  const [mono] = useState(() =>
    typeof window === "undefined" ? "monospace" : `${getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains").trim() || "ui-monospace"}, ui-monospace, monospace`,
  );

  const counts = useMemo(() => {
    const c = { tool: 0, schema: 0, issuer: 0, missing: 0 };
    for (const l of lines) {
      if (l.status === "missing") c.missing += 1;
      else if (l.status === "issuer") c.issuer += 1;
      else if (l.status === "ok") c[l.provenance?.kind === "schema" ? "schema" : "tool"] += 1;
    }
    return c;
  }, [lines]);

  const whyLines = lines.filter((l) => l.provenance?.why);

  useEffect(() => {
    const deco = decoRef.current;
    if (!deco || !mounted) return;
    deco.set(
      lines
        .filter((l) => l.status !== "blank")
        .map((l) => ({
          range: { startLineNumber: l.line, startColumn: 1, endLineNumber: l.line, endColumn: 1 },
          options: {
            isWholeLine: true,
            ...(l.status === "missing" ? { className: "kh-line-missing" } : {}),
            glyphMarginClassName: `kh-glyph ${l.status === "missing" ? "kh-glyph-missing" : l.status === "issuer" ? "kh-glyph-issuer" : l.provenance?.kind === "schema" ? "kh-glyph-schema" : "kh-glyph-ok"}`,
            glyphMarginHoverMessage: { value: l.status === "missing" ? "No evidence. Cannot be approved." : `Evidence: ${chipLabel(l.provenance)}` },
          },
        })),
    );
  }, [lines, mounted]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    decoRef.current = editor.createDecorationsCollection();
    editor.onDidScrollChange((e) => setScrollTop(e.scrollTop));
    editor.onDidChangeCursorPosition((e) => setCursor(e.position.lineNumber));
    setMounted(true);
  };

  const height = `clamp(320px, ${lines.length * LINE_H + 12}px, min(680px, 72vh))`;
  const reason =
    missing.length > 0 ? `${formatLineList(missing)} ${missing.length === 1 ? "has" : "have"} no evidence. Edit or remove ${missing.length === 1 ? "it" : "them"} to approve.` : approveBlock;

  const removeLine = (n: number) => {
    const all = yaml.split(/\r?\n/);
    all.splice(n - 1, 1);
    onYamlChange(all.join("\n"));
  };

  return (
    <div className="space-y-5">
      <style>{EDITOR_CSS}</style>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-drift/40 bg-drift/10 px-2 py-1 font-medium text-drift">
          <PenLine className="size-3.5" aria-hidden="true" /> AI draft. Every line needs evidence.
        </span>
        <span className="rounded-md border border-wire bg-inset px-2 py-1 font-mono text-muted tnum">{counts.tool} tool</span>
        <span className="rounded-md border border-wire bg-inset px-2 py-1 font-mono text-muted tnum">{counts.schema} schema</span>
        <span className="rounded-md border border-wire bg-inset px-2 py-1 font-mono text-muted tnum">{counts.issuer} issuer</span>
        <span className={cn("rounded-md border px-2 py-1 font-mono tnum", counts.missing ? "border-broken/50 bg-broken/10 text-broken" : "border-wire bg-inset text-muted")}>{counts.missing} no evidence</span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 overflow-hidden rounded-xl border border-wire bg-inset shadow-[0_1px_0_rgb(255_255_255/0.04)_inset,0_18px_40px_-24px_rgb(0_0_0/0.7)]">
          <div className="flex h-9 items-center gap-2 border-b border-wire px-3 text-xs text-subtle">
            <span className="flex gap-1" aria-hidden="true">
              <span className="size-2 rounded-full bg-line-strong" />
              <span className="size-2 rounded-full bg-line-strong" />
              <span className="size-2 rounded-full bg-line-strong" />
            </span>
            <span className="font-mono">kirch-spec.yaml</span>
            <span className="ml-auto font-mono tnum">
              L{cursor} · {lines.length} lines
            </span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(180px,0.42fr)]" style={{ height }}>
            <div className="relative min-w-0" data-testid="spec-editor" aria-label="KIRCH-SPEC YAML editor">
              {!mounted ? (
                <pre aria-hidden="true" className="absolute inset-0 z-10 overflow-hidden bg-inset py-0 pl-[62px] font-mono text-[13px] leading-[20px] text-muted">
                  {yaml}
                </pre>
              ) : null}
              <MonacoEditor
                height="100%"
                language="yaml"
                value={yaml}
                theme={theme === "light" ? "kh-light" : "kh-dark"}
                beforeMount={beforeMount}
                onMount={onMount}
                onChange={(v) => onYamlChange(v ?? "")}
                loading={null}
                options={{
                  fontFamily: mono,
                  fontSize: 13,
                  lineHeight: LINE_H,
                  minimap: { enabled: false },
                  glyphMargin: true,
                  folding: false,
                  lineDecorationsWidth: 6,
                  lineNumbersMinChars: 3,
                  scrollBeyondLastLine: false,
                  wordWrap: "off",
                  renderLineHighlight: "line",
                  overviewRulerLanes: 0,
                  hideCursorInOverviewRuler: true,
                  scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                  padding: { top: 0, bottom: 0 },
                  tabSize: 2,
                  ariaLabel: "KIRCH-SPEC YAML. Lines without evidence are marked and block approval.",
                }}
              />
            </div>
            <div aria-hidden="true" className="relative hidden overflow-hidden border-l border-wire bg-panel/40 lg:block">
              <div style={{ transform: `translateY(${-scrollTop}px)` }} className="will-change-transform">
                {lines.map((l) => (
                  <div key={l.line} className={cn("flex items-center gap-1.5 px-2", l.line === cursor && "bg-raised/60")} style={{ height: LINE_H }}>
                    {l.status !== "blank" ? <ProvenanceChip l={l} interactive={false} /> : null}
                    {l.provenance?.why ? <span className="truncate text-2xs text-muted">{l.provenance.why}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <aside className="space-y-4">
          <section aria-labelledby="line-evidence" className="rounded-xl border border-wire bg-panel p-4 shadow-panel">
            <h3 id="line-evidence" className="mb-3 text-sm font-semibold text-fg">
              Line evidence
            </h3>
            <LineEvidence l={lines[cursor - 1]} />
          </section>
          {missing.length > 0 ? (
            <section aria-labelledby="needs-evidence" className="rounded-xl border border-broken/40 bg-broken/5 p-4">
              <h3 id="needs-evidence" className="flex items-center gap-1.5 text-sm font-semibold text-broken">
                <CircleAlert className="size-4" aria-hidden="true" /> No evidence
              </h3>
              <ul className="mt-2 space-y-1.5">
                {missing.map((n) => (
                  <li key={n} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        editorRef.current?.revealLineInCenter(n);
                        editorRef.current?.setPosition({ lineNumber: n, column: 1 });
                        editorRef.current?.focus();
                      }}
                      className="flex w-full cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-broken/10"
                    >
                      <span className="font-mono text-xs text-broken tnum">L{n}</span>
                      <span className="min-w-0 truncate font-mono text-xs text-fg">{lines[n - 1]?.text.trim()}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeLine(n)}
                      data-testid="remove-line"
                      aria-label={`Remove line ${n}`}
                      className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs text-broken hover:bg-broken/10"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {validation && validation.errors.length > 0 ? (
            <section aria-labelledby="validation-flags" className="rounded-xl border border-wire bg-panel p-4">
              <h3 id="validation-flags" className="text-sm font-semibold text-fg">
                Copilot validation
              </h3>
              <ul className="mt-2 space-y-1.5 text-sm text-muted">
                {validation.errors.map((e, i) => (
                  <li key={i}>
                    {e.line !== null ? <span className="mr-1.5 font-mono text-xs text-drift tnum">draft L{e.line}</span> : null}
                    {e.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {whyLines.length > 0 ? (
            <section aria-labelledby="why-minters" className="rounded-xl border border-wire bg-panel p-4">
              <h3 id="why-minters" className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <ShieldCheck className="size-4 text-conserved" aria-hidden="true" /> Why these minters
              </h3>
              <ul className="mt-2 space-y-2 text-sm text-muted">
                {whyLines.map((l) => (
                  <li key={l.line}>
                    <span className="mr-1.5 font-mono text-xs text-subtle tnum">L{l.line}</span>
                    {l.provenance?.why}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>

      {children}

      <div className="flex flex-col gap-3 rounded-xl border border-wire bg-panel p-4 shadow-panel sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{reason ? "Approval blocked" : "Every line carries evidence"}</p>
          <p id="approve-reason" className={cn("text-sm", reason ? "text-broken" : "text-muted")}>
            {reason ?? "History conserves. Approve to prepare the Safe proposal. Nothing goes onchain yet."}
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={onApprove} disabled={reason !== null || yaml.trim().length === 0} aria-describedby="approve-reason" data-testid="approve-spec">
          <FileCheck2 aria-hidden="true" /> Approve spec
        </Button>
      </div>
    </div>
  );
}
