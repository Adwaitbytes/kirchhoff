"use client";

import { useEffect, useRef } from "react";
import { usePrefs } from "@/lib/prefs";

/**
 * A halftone field of dots that behaves like a circuit board under current.
 * Three traces carry teal current into a central junction; every few seconds a forged red
 * pulse runs in on one trace and is stopped at the junction. Canvas 2D, bucketed fills, paused
 * offscreen and in background tabs, one static frame under prefers-reduced-motion.
 */

interface Trace {
  pts: { x: number; y: number }[];
  len: number;
}

interface Dot {
  x: number;
  y: number;
  base: number;
  trace: number;
  dist: number;
  along: number;
  dj: number;
}

const LEVELS = 9;
const BREACH_EVERY = 9.5;

function buildTraces(w: number, h: number, portrait: boolean, snap: (v: number) => number): { traces: Trace[]; j: { x: number; y: number } } {
  const j = { x: snap(w * 0.5), y: snap(h * (portrait ? 0.86 : 0.875)) };
  const yLane = snap(h * (portrait ? 0.76 : 0.7));
  const xL = snap(w * (portrait ? 0.14 : 0.2));
  const xR = snap(w * (portrait ? 0.86 : 0.8));
  const raw = [
    [{ x: -20, y: yLane }, { x: xL, y: yLane }, { x: xL, y: j.y }, { x: j.x - 2, y: j.y }],
    [{ x: w + 20, y: yLane }, { x: xR, y: yLane }, { x: xR, y: j.y }, { x: j.x + 2, y: j.y }],
    [{ x: j.x, y: h + 20 }, { x: j.x, y: j.y + 2 }],
  ];
  const traces = raw.map((pts) => {
    let len = 0;
    for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    return { pts, len };
  });
  return { traces, j };
}

function project(t: Trace, x: number, y: number): { dist: number; along: number } {
  let best = { dist: Infinity, along: 0 };
  let acc = 0;
  for (let i = 1; i < t.pts.length; i += 1) {
    const a = t.pts[i - 1]!;
    const b = t.pts[i]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    const u = Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / l2));
    const px = a.x + u * abx;
    const py = a.y + u * aby;
    const d = Math.hypot(x - px, y - py);
    const seg = Math.sqrt(l2);
    if (d < best.dist) best = { dist: d, along: acc + u * seg };
    acc += seg;
  }
  return best;
}

function pointAt(t: Trace, dist: number): { x: number; y: number } {
  let left = Math.max(0, Math.min(t.len, dist));
  for (let i = 1; i < t.pts.length; i += 1) {
    const a = t.pts[i - 1]!;
    const b = t.pts[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= seg) {
      const u = seg === 0 ? 0 : left / seg;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
    left -= seg;
  }
  const last = t.pts[t.pts.length - 1]!;
  return { x: last.x, y: last.y };
}

/** A comet of light: a short tail along the trace ending at `head`, drawn with a glow. */
function comet(ctx: CanvasRenderingContext2D, t: Trace, head: number, tail: number, color: string, width: number) {
  if (head <= 0) return;
  const steps = 10;
  const from = Math.max(0, head - tail);
  for (let i = 0; i < steps; i += 1) {
    const a = pointAt(t, from + ((head - from) * i) / steps);
    const b = pointAt(t, from + ((head - from) * (i + 1)) / steps);
    ctx.strokeStyle = withAlpha(color, ((i + 1) / steps) ** 1.6);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const p = pointAt(t, head);
  ctx.fillStyle = withAlpha("#ffffff", 0.9);
  ctx.beginPath();
  ctx.arc(p.x, p.y, width * 0.9, 0, Math.PI * 2);
  ctx.fill();
}

function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

export function CurrentField({ variant = "hero", className, focus = 0.62 }: { variant?: "hero" | "ambient" | "glow"; className?: string; focus?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { reducedMotion, theme, motionScale } = usePrefs();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dots: Dot[] = [];
    let traces: Trace[] = [];
    let junction = { x: 0, y: 0 };
    let raf = 0;
    let running = false;
    let visible = true;
    const start = performance.now();
    const pointer = { x: -9999, y: -9999, heat: 0 };
    const colors = {
      dot: cssColor("--fg-subtle", "#7d8693"),
      teal: variant === "glow" ? cssColor("--mint", "#7fdcae") : cssColor("--status-conserved", "#2dd4bf"),
      red: cssColor("--status-broken", "#f43f5e"),
    };
    const light = theme === "light";
    const monoFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-dm-mono").trim() || "ui-monospace, monospace";

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const portrait = w < 700;
      const gap = portrait ? 11 : 13;
      const snap = (v: number) => gap / 2 + Math.round((v - gap / 2) / gap) * gap;
      const built = buildTraces(w, h, portrait, snap);
      traces = variant === "hero" ? built.traces : [];
      junction = variant === "hero" ? built.j : { x: w * 0.5, y: h * (variant === "glow" ? focus : 0.5) };
      const cx = w * 0.5;
      const cy = variant === "hero" ? h * 0.6 : variant === "glow" ? h * focus : h * 0.5;
      const rx = w * (variant === "hero" ? 0.7 : variant === "glow" ? 0.8 : 0.55);
      const ry = h * (variant === "hero" ? 0.75 : variant === "glow" ? 0.9 : 0.62);
      dots = [];
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          const base = Math.max(0, 1 - e) ** 1.4;
          let trace = -1;
          let dist = Infinity;
          let along = 0;
          traces.forEach((t, i) => {
            const p = project(t, x, y);
            if (p.dist < dist) {
              dist = p.dist;
              along = p.along;
              trace = i;
            }
          });
          if (base < 0.02 && dist > 60) continue;
          dots.push({ x, y, base, trace, dist, along, dj: Math.hypot(x - junction.x, y - junction.y) });
        }
      }
    };

    const frame = (now: number) => {
      const t = ((now - start) / 1000) / motionScale;
      ctx.clearRect(0, 0, w, h);
      const tealB: Path2D[] = Array.from({ length: LEVELS }, () => new Path2D());
      const redB: Path2D[] = Array.from({ length: LEVELS }, () => new Path2D());
      const baseB: Path2D[] = Array.from({ length: LEVELS }, () => new Path2D());

      // Breach cycle: a red pulse runs in on trace 0, the junction flares, currents stall.
      const bc = t % BREACH_EVERY;
      const breachRun = variant === "hero" && bc < 1.5;
      const flare = variant === "hero" && bc >= 1.5 && bc < 3.1 ? 1 - (bc - 1.5) / 1.6 : 0;
      const stall = flare > 0 ? 0.35 : 1;
      const ringT = (t % 3.2) / 3.2;

      for (const d of dots) {
        let base = (0.34 + 0.16 * Math.sin(d.x * 0.011 + d.y * 0.009 - t * 0.7)) * d.base;
        let teal = 0;
        let red = 0;
        if (d.trace >= 0 && d.dist < 60) {
          const tr = traces[d.trace]!;
          const wire = Math.exp(-((d.dist / 5) ** 2));
          const halo = Math.exp(-((d.dist / 24) ** 2));
          const p = (((d.along - t * 150) / 230) % 1 + 1) % 1;
          const pulse = Math.exp(-(((p - 0.5) / 0.11) ** 2));
          teal += (wire * (0.42 + 1.1 * pulse) + halo * 0.55 * pulse) * stall;
          if (breachRun && d.trace === 0) {
            const head = (bc / 1.5) * tr.len;
            const k = Math.exp(-(((d.along - head) / 40) ** 2));
            red += (wire * 1.1 + halo * 0.45) * k;
          }
        }
        if (variant === "hero") {
          const jg = Math.exp(-((d.dj / 110) ** 2)) * (0.8 + 0.2 * Math.sin(t * 1.4));
          teal += jg * (flare > 0 ? 0.25 : 1);
          const r = ringT * 240;
          teal += Math.exp(-(((d.dj - r) / 14) ** 2)) * (1 - ringT) * 0.6 * stall;
          if (flare > 0) {
            const fr = (1 - flare) * 260;
            red += Math.exp(-((d.dj / 70) ** 2)) * flare * 1.1 + Math.exp(-(((d.dj - fr) / 16) ** 2)) * flare * 0.8;
          }
        }
        if (variant === "glow") {
          // A mint bloom on the dot field around the focal object, breathing slowly.
          const g = Math.exp(-((d.dj / (w < 700 ? 150 : 260)) ** 2)) * (0.62 + 0.12 * Math.sin(t * 0.9));
          teal += g;
        }
        if (pointer.heat > 0) {
          const dp = Math.hypot(d.x - pointer.x, d.y - pointer.y);
          teal += Math.exp(-((dp / 110) ** 2)) * 0.55 * pointer.heat;
        }
        if (light) base *= 1.6;
        const put = (buckets: Path2D[], v: number, size: number) => {
          const lvl = Math.min(LEVELS - 1, Math.floor(v * LEVELS));
          if (lvl <= 0) return;
          buckets[lvl]!.rect(d.x - size / 2, d.y - size / 2, size, size);
        };
        if (red > 0.06) put(redB, red, 2.6);
        else if (teal > 0.06) put(tealB, teal, teal > 0.6 ? 2.6 : 2);
        else put(baseB, base, 1.8);
      }
      for (let i = 1; i < LEVELS; i += 1) {
        const a = i / (LEVELS - 1);
        ctx.fillStyle = withAlpha(colors.dot, a * (light ? 0.9 : 0.75));
        ctx.fill(baseB[i]!);
        ctx.fillStyle = withAlpha(colors.teal, Math.min(1, a * 1.05));
        ctx.fill(tealB[i]!);
        ctx.fillStyle = withAlpha(colors.red, Math.min(1, a * 1.1));
        ctx.fill(redB[i]!);
      }
      pointer.heat = Math.max(0, pointer.heat - 0.012);

      if (variant !== "hero") return;
      // Wires and their current, drawn as light over the halftone.
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const tr of traces) {
        ctx.strokeStyle = withAlpha(flare > 0 && tr === traces[0] ? colors.red : colors.teal, 0.4 * stall + 0.12);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        tr.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
      }
      ctx.shadowColor = colors.teal;
      ctx.shadowBlur = 14;
      const spacing = 340;
      for (const tr of traces) {
        for (let k = 0; k < Math.ceil(tr.len / spacing) + 1; k += 1) {
          const head = ((t * 190 * stall + k * spacing) % (tr.len + spacing)) - 20;
          if (head > 0 && head < tr.len) comet(ctx, tr, head, 110, colors.teal, 2.2);
        }
      }
      if (breachRun) {
        const tr = traces[0];
        if (tr) {
          ctx.shadowColor = colors.red;
          ctx.shadowBlur = 22;
          comet(ctx, tr, (bc / 1.5) * tr.len, 180, colors.red, 3);
        }
      }
      // The junction: a glowing core with Kirchhoff rings.
      const core = flare > 0 ? colors.red : colors.teal;
      const g = ctx.createRadialGradient(junction.x, junction.y, 0, junction.x, junction.y, 190);
      g.addColorStop(0, withAlpha(core, 0.38 + 0.12 * Math.sin(t * 1.4)));
      g.addColorStop(1, withAlpha(core, 0));
      ctx.shadowBlur = 0;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(junction.x, junction.y, 190, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 2; k += 1) {
        const rr = ((ringT + k / 2) % 1) * 150 + 10;
        ctx.strokeStyle = withAlpha(core, (1 - rr / 160) * 0.6);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(junction.x, junction.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.shadowColor = core;
      ctx.shadowBlur = 28;
      ctx.fillStyle = withAlpha(light ? core : "#ffffff", 0.95);
      ctx.beginPath();
      ctx.arc(junction.x, junction.y, 5.5 + (flare > 0 ? 3 * flare : 0), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = withAlpha(core, 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(junction.x, junction.y, 16, 0, Math.PI * 2);
      ctx.stroke();
      // The readout under the junction: the whole pitch in one line.
      ctx.shadowBlur = flare > 0 ? 18 : 10;
      ctx.font = `500 ${w < 700 ? 12 : 14}px ${monoFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = withAlpha(core, 1);
      ctx.fillText(flare > 0 ? "forged credit · refused" : "Σ in = Σ out", junction.x, junction.y + 30);
      ctx.restore();
    };

    const loop = (now: number) => {
      frame(now);
      raf = requestAnimationFrame(loop);
    };
    const play = () => {
      if (running || reducedMotion || !visible || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const pause = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    layout();
    frame(start + 2200);
    play();

    const ro = new ResizeObserver(() => {
      layout();
      if (!running) frame(performance.now());
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting ?? true;
      if (visible) play();
      else pause();
    });
    io.observe(canvas);
    const onVis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVis);
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.heat = 1;
    };
    const host = canvas.parentElement;
    if (!reducedMotion) host?.addEventListener("pointermove", onMove);

    return () => {
      pause();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      host?.removeEventListener("pointermove", onMove);
    };
  }, [variant, reducedMotion, theme, motionScale, focus]);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
