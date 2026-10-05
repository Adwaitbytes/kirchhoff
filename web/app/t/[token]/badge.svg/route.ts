import type { TokenStatus, TokenStatusResponse } from "@/lib/api/types";
import { FixtureWorld } from "@/lib/api/fixtures";
import { API_URL } from "@/lib/api/client";
import { formatAmount, parseWei } from "@/lib/format";

/**
 * Embeddable status badge: GET /t/{token}/badge.svg
 * Reads the mirrored status server side. On any failure it renders UNKNOWN in grey and never
 * invents a number. Dark, on-brand, monospace so widths are predictable without font metrics.
 */

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<TokenStatus, string> = {
  CONSERVED: "#2DD4BF",
  DRIFT: "#FBBF24",
  BROKEN: "#F43F5E",
  QUARANTINED: "#A78BFA",
  RECOVERING: "#60A5FA",
  UNKNOWN: "#8B93A0",
};

const FONT = 11;
const CHAR_W = 6.62;
const PAD = 10;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

function textWidth(s: string): number {
  return Math.ceil(s.length * CHAR_W);
}

interface BadgeInput {
  token: string;
  status: TokenStatus;
  delta: string | null;
  note: string | null;
}

function renderBadge({ token, status, delta, note }: BadgeInput): string {
  const color = STATUS_COLOR[status];
  const left = `KIRCHHOFF ${token}`;
  const right = delta === null ? status : `${status} · Δ ${delta}`;
  const tail = note ? ` ${note}` : "";
  const leftW = PAD * 2 + 10 + textWidth(left);
  const rightW = PAD * 2 + 12 + textWidth(right) + (tail ? textWidth(tail) : 0);
  const w = leftW + rightW;
  const h = 22;
  const label = `${left}: ${right}${tail}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(label)}">
<title>${escapeXml(label)}</title>
<defs>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".07"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="${h}" rx="5"/></clipPath>
</defs>
<g clip-path="url(#r)">
<rect width="${leftW}" height="${h}" fill="#12151A"/>
<rect x="${leftW}" width="${rightW}" height="${h}" fill="#0B0D10"/>
<rect x="${leftW}" width="${rightW}" height="${h}" fill="${color}" fill-opacity=".12"/>
<rect width="${w}" height="${h}" fill="url(#g)"/>
</g>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="4.5" fill="none" stroke="#2A313B"/>
<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${FONT}" font-weight="600">
<circle cx="${PAD + 3}" cy="${h / 2}" r="3" fill="#2DD4BF"/>
<text x="${PAD + 10}" y="15" fill="#E7EAEE">${escapeXml(left)}</text>
<circle cx="${leftW + PAD + 3}" cy="${h / 2}" r="3.5" fill="${color}"/>
<text x="${leftW + PAD + 12}" y="15" fill="${color}">${escapeXml(right)}${tail ? `<tspan fill="#7D8693" font-weight="400">${escapeXml(tail)}</tspan>` : ""}</text>
</g>
</svg>`;
}

const TOKEN_RE = /^[A-Za-z0-9._-]{1,32}$/;

async function loadStatus(token: string): Promise<{ status: TokenStatusResponse | null; fixture: boolean }> {
  if (process.env.NEXT_PUBLIC_DATA_SOURCE === "fixtures") {
    return { status: new FixtureWorld("live").status(token), fixture: true };
  }
  const base = API_URL;
  try {
    const res = await fetch(`${base}/tokens/${encodeURIComponent(token)}/status`, { signal: AbortSignal.timeout(3_000), cache: "no-store", headers: { Accept: "application/json" } });
    if (!res.ok) return { status: null, fixture: false };
    return { status: (await res.json()) as TokenStatusResponse, fixture: false };
  } catch (e) {
    console.error("badge.svg: status read failed", e);
    return { status: null, fixture: false };
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token: raw } = await params;
  const decoded = decodeURIComponent(raw);
  const token = TOKEN_RE.test(decoded) ? decoded : "token";
  const { status, fixture } = TOKEN_RE.test(decoded) ? await loadStatus(token) : { status: null, fixture: false };

  let input: BadgeInput;
  if (status && /^-?\d+$/.test(status.token.delta)) {
    const t = status.token;
    const s: TokenStatus = t.stale && (t.status === "CONSERVED" || t.status === "DRIFT") ? "UNKNOWN" : t.status;
    input = {
      token: t.symbol,
      status: s,
      delta: formatAmount(parseWei(t.delta), { decimals: t.decimals, maxFraction: 0, signed: true }).replace("−", "-"),
      note: fixture ? "fixture" : null,
    };
  } else {
    input = { token, status: "UNKNOWN", delta: null, note: fixture ? "fixture" : null };
  }

  return new Response(renderBadge(input), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=30, s-maxage=30, stale-while-revalidate=60",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
