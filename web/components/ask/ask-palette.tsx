"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { Activity, ArrowLeft, CornerDownLeft, Database, FlaskConical, Globe, Moon, Plug, Server, Sparkles, Sun, Wand2 } from "lucide-react";
import { useApi } from "@/lib/api/provider";
import { usePrefs } from "@/lib/prefs";
import { useTokens } from "@/lib/api/hooks";
import type { AskCitation } from "@/lib/api/types";
import { isApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface Turn {
  role: "user" | "assistant";
  content: string;
  citations: AskCitation[];
  tools: string[];
  error: string | null;
  done: boolean;
}

const SUGGESTIONS = ["Which lanes are frozen right now?", "Why did the last refused message fail?", "What is Δ for kETH right now?"];

function tokenFromPath(path: string): string | null {
  const m = /^\/(?:app\/tokens|t)\/([^/]+)/.exec(path);
  return m?.[1] ? decodeURIComponent(m[1]) : path.startsWith("/lab") ? "kETH" : null;
}

/** Renders answer text with [n] markers as citation chips linking to the cited tx or row. */
function CitedText({ text, citations }: { text: string; citations: AskCitation[] }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <p className="text-sm leading-relaxed text-fg">
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const c = citations.find((x) => x.n === Number(m[1]));
        if (!c) return <span key={i} className="text-subtle">{p}</span>;
        return (
          <a
            key={i}
            href={c.href}
            target="_blank"
            rel="noopener noreferrer"
            title={c.label}
            className="mx-0.5 inline-flex h-5 items-center rounded border border-wire bg-inset px-1.5 align-[1px] font-mono text-2xs text-muted hover:border-line-strong hover:text-fg"
          >
            {c.n}
          </a>
        );
      })}
    </p>
  );
}

export function AskPalette() {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const tokens = useTokens();
  const { theme, setTheme } = usePrefs();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"commands" | "chat">("commands");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const token = tokenFromPath(pathname);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onAsk = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("kh:ask", onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("kh:ask", onAsk);
    };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;
      setMode("chat");
      setInput("");
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const history = turns.filter((t) => t.done && !t.error).slice(-10).map((t) => ({ role: t.role, content: t.content }));
      setTurns((prev) => [...prev, { role: "user", content: q, citations: [], tools: [], error: null, done: true }, { role: "assistant", content: "", citations: [], tools: [], error: null, done: false }]);
      const patch = (fn: (t: Turn) => Turn) => setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? fn(t) : t)));
      try {
        await api.ask({ question: q, token, history }, (e) => {
          switch (e.type) {
            case "text":
              patch((t) => ({ ...t, content: t.content + e.delta }));
              break;
            case "citation":
              patch((t) => ({ ...t, citations: [...t.citations, e.citation] }));
              break;
            case "tool":
              patch((t) => ({ ...t, tools: [...t.tools, e.summary] }));
              break;
            case "error":
              patch((t) => ({ ...t, error: e.message, done: true }));
              break;
            case "done":
              patch((t) => ({ ...t, done: true }));
              break;
          }
        }, ctrl.signal);
        patch((t) => ({ ...t, done: true }));
      } catch (err) {
        if (ctrl.signal.aborted) return;
        patch((t) => ({ ...t, done: true, error: isApiError(err) ? err.message : "Ask KIRCHHOFF failed. Try again." }));
      }
    },
    [api, token, turns],
  );

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const commands = useMemo(
    () => [
      ...(tokens.data?.items ?? []).map((t) => ({ id: `mc-${t.symbol}`, label: `Mission Control: ${t.symbol}`, icon: Activity, href: `/app/tokens/${t.symbol}` })),
      { id: "lab", label: "Attack Lab", icon: FlaskConical, href: "/lab" },
      { id: "onboard", label: "Onboard a token", icon: Wand2, href: "/app/onboard" },
      { id: "ops", label: "Verifier Ops", icon: Server, href: "/app/ops" },
      { id: "integrate", label: "Integrations", icon: Plug, href: "/app/integrate" },
      ...(tokens.data?.items ?? []).map((t) => ({ id: `status-${t.symbol}`, label: `Public status: ${t.symbol}`, icon: Globe, href: `/t/${t.symbol}` })),
    ],
    [tokens.data],
  );

  return (
    <D.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setMode("commands");
      }}
    >
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <D.Content className="fixed left-1/2 top-[14vh] z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-wire bg-panel shadow-pop focus:outline-none">
          <D.Title className="sr-only">Ask KIRCHHOFF</D.Title>
          <D.Description className="sr-only">Ask about the read model or jump to a screen. Answers cite onchain evidence.</D.Description>
          {mode === "commands" ? (
            <Command label="Ask KIRCHHOFF" loop className="flex flex-col">
              <div className="flex items-center gap-3 border-b border-wire px-4">
                <Sparkles className="size-4 shrink-0 text-conserved" aria-hidden="true" />
                <Command.Input
                  value={input}
                  onValueChange={setInput}
                  placeholder="Ask KIRCHHOFF or jump to a screen"
                  className="h-14 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-subtle"
                />
                <kbd className="rounded border border-wire px-1.5 py-0.5 font-mono text-2xs text-subtle">esc</kbd>
              </div>
              <Command.List className="max-h-[360px] overflow-y-auto p-2">
                <Command.Empty className="px-3 py-6 text-center text-sm text-muted">Press Enter to ask.</Command.Empty>
                <Command.Group heading="Ask" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-subtle">
                  {input.trim() ? (
                    <PaletteItem value={`ask ${input}`} onSelect={() => void ask(input)} icon={Sparkles} label={`Ask: ${input.trim()}`} hint />
                  ) : (
                    SUGGESTIONS.map((s) => <PaletteItem key={s} value={s} onSelect={() => void ask(s)} icon={Sparkles} label={s} />)
                  )}
                </Command.Group>
                <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-subtle">
                  {commands.map((c) => (
                    <PaletteItem key={c.id} value={c.label} onSelect={() => go(c.href)} icon={c.icon} label={c.label} />
                  ))}
                  <PaletteItem
                    value="Switch theme"
                    onSelect={() => setTheme(theme === "dark" ? "light" : "dark")}
                    icon={theme === "dark" ? Sun : Moon}
                    label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                  />
                </Command.Group>
              </Command.List>
            </Command>
          ) : (
            <div className="flex max-h-[min(640px,72vh)] flex-col">
              <div className="flex items-center gap-2 border-b border-wire px-3 py-2.5">
                <button type="button" onClick={() => setMode("commands")} className="cursor-pointer rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" aria-label="Back to commands">
                  <ArrowLeft className="size-4" />
                </button>
                <span className="text-sm font-semibold">Ask KIRCHHOFF</span>
                {token ? <span className="rounded border border-wire px-1.5 py-0.5 font-mono text-2xs text-muted">{token}</span> : null}
                <span className="ml-auto text-xs text-subtle">Read-only. Answers cite rows and transactions.</span>
              </div>
              <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4" aria-live="polite">
                {turns.map((t, i) =>
                  t.role === "user" ? (
                    <p key={i} className="text-sm font-medium text-fg">
                      {t.content}
                    </p>
                  ) : (
                    <div key={i} className="space-y-2 border-l-2 border-wire pl-3">
                      {t.tools.map((tool, j) => (
                        <p key={j} className="flex items-center gap-1.5 font-mono text-2xs text-subtle">
                          <Database className="size-3" aria-hidden="true" />
                          {tool}
                        </p>
                      ))}
                      {t.content ? <CitedText text={t.content} citations={t.citations} /> : !t.error ? <div className="skeleton h-4 w-2/3" /> : null}
                      {t.error ? <p className="text-sm text-broken">{t.error}</p> : null}
                      {t.done && !t.error ? <p className="text-2xs text-subtle">AI answer. Verify against the cited evidence.</p> : null}
                    </div>
                  ),
                )}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask(input);
                }}
                className="flex items-center gap-2 border-t border-wire px-4 py-3"
              >
                <label htmlFor="ask-followup" className="sr-only">
                  Follow-up question
                </label>
                <input
                  id="ask-followup"
                  autoFocus
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask a follow-up"
                  className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
                />
                <button type="submit" className="flex cursor-pointer items-center gap-1 rounded-md border border-wire px-2 py-1 text-xs text-muted hover:text-fg" disabled={!input.trim()}>
                  <CornerDownLeft className="size-3.5" aria-hidden="true" />
                  Ask
                </button>
              </form>
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function PaletteItem({ value, onSelect, icon: Icon, label, hint = false }: { value: string; onSelect: () => void; icon: typeof Sparkles; label: string; hint?: boolean }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn("flex h-10 cursor-pointer items-center gap-3 rounded-md px-2.5 text-sm text-muted data-[selected=true]:bg-raised data-[selected=true]:text-fg")}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {hint ? <CornerDownLeft className="ml-auto size-3.5 text-subtle" aria-hidden="true" /> : null}
    </Command.Item>
  );
}
