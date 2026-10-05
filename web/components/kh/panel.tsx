import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({ className, children, ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section className={cn("panel flex min-h-0 min-w-0 flex-col", className)} {...props}>
      {children}
    </section>
  );
}

export function PanelHeader({ title, meta, actions, id, className }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  return (
    <header className={cn("flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-wire px-4 py-2.5", className)}>
      <h2 id={id} className="text-sm font-semibold tracking-[-0.005em] text-fg">
        {title}
      </h2>
      {meta ? (
        typeof meta === "string" && meta.split(/\s+/).length > 6 ? (
          <div className="min-w-0 truncate text-[13px] text-subtle">{meta}</div>
        ) : (
          <div className="min-w-0 truncate font-mono text-2xs uppercase tracking-[0.08em] text-subtle">{meta}</div>
        )
      ) : null}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({ title, action, icon }: { title: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {icon ? <div className="text-subtle">{icon}</div> : null}
      <p className="max-w-[36ch] text-sm text-muted">{title}</p>
      {action}
    </div>
  );
}
