// Builds media/deck/KIRCHHOFF.pptx, the 8-slide stage deck (PRD section 15).
//
//   cd media/deck && npm install && npm run build
//
// Rerun after the final recording or new measurements land:
//   - media/video/kirchhoff-demo.mp4 present  -> embedded in slide 4 (inside the .pptx, never linked)
//   - media/video/kirchhoff-demo.mp4 missing  -> a placeholder frame is shown and the build says so
//   - every number on a slide comes from METRICS below; each entry names the repo file it was read from.
//     An entry whose value is PENDING never reaches a slide, and the build lists it at the end.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const { applyTheme } = require("./apply-theme.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "KIRCHHOFF.pptx");
const BUILD = path.join(__dirname, ".build");
const VIDEO = path.join(ROOT, "media", "video", "kirchhoff-demo.mp4");
const PLACEHOLDER_SOURCE = path.join(ROOT, "web", "e2e", "__screenshots__", "gallery", "mission-control-breach-stage-dark.png");

const PENDING = "[pending]";

// ---------------------------------------------------------------------------------------------
// Data. Every number shown on a slide lives here with the file it was measured in.
// ---------------------------------------------------------------------------------------------

const METRICS = {
  kelpLoss: { value: "$292M", source: "docs/PRD.md section 1 (Crypto Times)" },
  kelpAmount: { value: "116,500 rsETH", source: "docs/PRD.md section 1 (Crypto Times)" },
  kelpChains: { value: "20", source: "docs/PRD.md section 1 (Phemex)" },
  bridgeLosses2026: { value: "$340M+", source: "docs/PRD.md section 1 (DexTools / PeckShield)" },
  bridgeIncidents2026: { value: "14", source: "docs/PRD.md section 1 (DexTools / PeckShield)" },
  creScenarios: { value: "6 / 6", source: "workflows/SIMULATION_LOG.md, scenarios 1 to 6 PASS" },
  w2Reads: { value: "12 / 15", source: "workflows/SIMULATION_LOG.md, 'W2 reads used 12/15'" },
  judgeP99Stub: { value: "6.13 ms", source: "judge/load/RESULTS.md run A (100 rps, in-process stub RPCs)" },
  engineBranches: { value: "586 / 586", source: "README.md 'Test results', engine coverage" },
  prdDone: { value: "350 of 466", source: "PRD_TRACEABILITY.md 'Summary'" },
  testsFoundry: { value: "150", source: "README.md 'Test results' (forge test)" },
  testsTs: { value: "463", source: "SUBMISSION.md 'Judging weights' (pnpm -r test)" },
  // Not measured yet. Kept here so the gap is visible; nothing below may render them.
  demoDuration: { value: PENDING, source: "ffprobe of media/video/kirchhoff-demo.mp4 (filled at build time)" },
  loopBreachToBroken: { value: PENDING, source: "PRD_TRACEABILITY.md 'Pending measurement' 2.M2" },
  copilotOnboardTime: { value: PENDING, source: "PRD_TRACEABILITY.md 'Pending measurement' 2.M6" },
  judgeP99RealRpc: { value: PENDING, source: "PRD_TRACEABILITY.md 'Pending measurement' 2.M4" },
  falseBrokenBacktest: { value: PENDING, source: "PRD_TRACEABILITY.md 'Pending measurement' 2.M3" },
  testnetKelpReplay: { value: PENDING, source: "PRD_TRACEABILITY.md 'Pending work' item 3" },
  resetWallTime: { value: PENDING, source: "PRD_TRACEABILITY.md 'Pending measurement' 15.REC1" },
};

// Team names are not recorded anywhere in the repo. Fill these in; the slide shows them once set.
const TEAM = [{ name: PENDING, role: PENDING }];

function metric(key) {
  const m = METRICS[key];
  if (!m) throw new Error(`Unknown metric "${key}"`);
  if (m.value === PENDING) throw new Error(`Metric "${key}" is ${PENDING} and must not reach a slide (${m.source})`);
  return m.value;
}

// ---------------------------------------------------------------------------------------------
// Design tokens, from web/app/globals.css (dark control room).
// ---------------------------------------------------------------------------------------------

const HEX = {
  base: "0B0D10",
  panel: "12151A",
  raised: "181C22",
  inset: "0E1115",
  wire: "2A313B",
  strong: "3A4350",
  fg: "E7EAEE",
  muted: "9AA3AF",
  subtle: "7D8693",
  teal: "2DD4BF",
  tealDim: "1C5F57",
  tealInk: "0F2A28",
  rose: "F43F5E",
  roseDim: "6B1F2C",
  roseInk: "2A1016",
  violet: "A78BFA",
  violetDim: "4A3D73",
  violetInk: "1D1830",
  blue: "60A5FA",
  blueDim: "264A73",
};

// Dark deck: text1 is the light foreground and background1 the base, so scheme colors read right.
const THEME = {
  name: "KIRCHHOFF Control Room",
  headFontFace: "Inter SemiBold",
  bodyFontFace: "Inter",
  colors: {
    dk1: HEX.fg,
    lt1: HEX.base,
    dk2: HEX.muted,
    lt2: HEX.panel,
    accent1: HEX.teal,
    accent2: HEX.rose,
    accent3: HEX.violet,
    accent4: "FBBF24",
    accent5: HEX.blue,
    accent6: HEX.subtle,
    hlink: HEX.teal,
    folHlink: HEX.violet,
  },
};

const SANS = "Inter";
const SANS_SB = "Inter SemiBold";
const MONO = "JetBrains Mono";

const W = 13.333;
const H = 7.5;
const MX = 0.6;
const CW = W - 2 * MX;
const TITLE_BOX = { x: MX, y: 0.84, w: CW, h: 0.78 };

// ---------------------------------------------------------------------------------------------
// Generated raster assets: backgrounds (dot grid plus ambient light, as in Mission Control) and
// the slide 4 placeholder or poster frame.
// ---------------------------------------------------------------------------------------------

async function backgroundPng(file, glow) {
  const pw = 2667;
  const ph = 1500;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">
  <defs>
    <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse">
      <circle cx="16" cy="16" r="1.5" fill="#9AA3AF" fill-opacity="0.16"/>
    </pattern>
    <radialGradient id="fade" cx="${glow.fadeX}" cy="${glow.fadeY}" r="0.75">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <mask id="m"><rect width="100%" height="100%" fill="url(#fade)"/></mask>
    <radialGradient id="a" cx="${glow.ax}" cy="${glow.ay}" r="${glow.ar}">
      <stop offset="0" stop-color="#2DD4BF" stop-opacity="${glow.aOpacity}"/>
      <stop offset="1" stop-color="#2DD4BF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="b" cx="0.92" cy="1.05" r="0.55">
      <stop offset="0" stop-color="#60A5FA" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#60A5FA" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="#0B0D10"/>
  <rect width="100%" height="100%" fill="url(#dots)" mask="url(#m)"/>
  <rect width="100%" height="100%" fill="url(#a)"/>
  <rect width="100%" height="100%" fill="url(#b)"/>
</svg>`;
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
}

async function placeholderFrame(file) {
  // The UI screenshot is fixture data, so it is blurred into texture: no number on it is legible.
  const bw = 1920;
  const bh = 1080;
  const blurred = await sharp(PLACEHOLDER_SOURCE).resize(bw, bh).blur(28).modulate({ brightness: 0.42, saturation: 0.9 }).toBuffer();
  const veil = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}">
    <defs><radialGradient id="v" cx="0.5" cy="0.5" r="0.7">
      <stop offset="0" stop-color="#0B0D10" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#0B0D10" stop-opacity="0.85"/>
    </radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#v)"/>
  </svg>`);
  await sharp(blurred).composite([{ input: veil }]).png().toFile(file);
}

function probeVideo(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", file], { encoding: "utf8" });
  const json = JSON.parse(out);
  const seconds = Number(json.format && json.format.duration);
  const codec = json.streams && json.streams[0] && json.streams[0].codec_name;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe could not read a duration from ${file}`);
  return { seconds, codec };
}

function posterFrame(file, out, seconds) {
  const at = Math.min(3, Math.max(0, seconds / 10)).toFixed(2);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", at, "-i", file, "-frames:v", "1", "-vf", "scale=1920:-2", out]);
}

function dataUri(file) {
  return "image/png;base64," + fs.readFileSync(file).toString("base64");
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers. pptxgenjs mutates option objects, so every call builds fresh ones.
// ---------------------------------------------------------------------------------------------

function text(slide, value, o) {
  slide.addText(value, {
    isTextBox: true,
    margin: 0,
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
    fontFace: o.font || SANS,
    fontSize: o.size || 14,
    color: o.color || HEX.fg,
    bold: o.bold || false,
    italic: o.italic || false,
    align: o.align || "left",
    valign: o.valign || "top",
    charSpacing: o.spacing,
    lineSpacingMultiple: o.lineSpacing || 1.12,
    paraSpaceAfter: o.paraAfter,
    objectName: o.name,
    fit: "none",
    wrap: true,
  });
}

function shadow() {
  return { type: "outer", color: "000000", opacity: 0.45, blur: 14, offset: 4, angle: 90 };
}

function panel(slide, x, y, w, h, o = {}) {
  slide.addShape("roundRect", {
    x,
    y,
    w,
    h,
    rectRadius: o.radius === undefined ? 0.14 : o.radius,
    fill: { color: o.fill || HEX.panel, transparency: o.fillTransparency || 0 },
    line: o.line === null ? { type: "none" } : { color: o.line || HEX.wire, width: o.lineWidth || 0.75, dashType: o.dash || "solid" },
    shadow: o.shadow === false ? undefined : shadow(),
    objectName: o.name,
  });
}

function line(slide, x1, y1, x2, y2, o = {}) {
  slide.addShape("line", {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.max(Math.abs(x2 - x1), 0.0001),
    h: Math.max(Math.abs(y2 - y1), 0.0001),
    flipH: x2 < x1,
    flipV: y2 < y1,
    line: {
      color: o.color || HEX.strong,
      width: o.width || 1.25,
      dashType: o.dash || "solid",
      endArrowType: o.arrow ? "triangle" : undefined,
      beginArrowType: o.arrowStart ? "triangle" : undefined,
    },
    objectName: o.name,
  });
}

function dot(slide, cx, cy, r, color, o = {}) {
  slide.addShape("ellipse", {
    x: cx - r,
    y: cy - r,
    w: 2 * r,
    h: 2 * r,
    fill: o.hollow ? { color: HEX.base } : { color },
    line: o.hollow || o.ring ? { color: o.ringColor || color, width: o.ringWidth || 1.25 } : { type: "none" },
    objectName: o.name,
  });
}

// Status pill in the product's style: mono caps, tinted fill, colored hairline, leading dot.
function pill(slide, label, x, y, tone, o = {}) {
  const tones = {
    teal: [HEX.teal, HEX.tealInk, HEX.tealDim],
    rose: [HEX.rose, HEX.roseInk, HEX.roseDim],
    violet: [HEX.violet, HEX.violetInk, HEX.violetDim],
    muted: [HEX.muted, HEX.raised, HEX.strong],
  };
  const [fg, fill, edge] = tones[tone];
  const size = o.size || 10;
  const h = o.h || 0.3;
  const w = o.w || 0.42 + label.length * size * 0.0092;
  slide.addShape("roundRect", { x, y, w, h, rectRadius: h / 2, fill: { color: fill }, line: { color: edge, width: 0.75 }, objectName: o.name });
  dot(slide, x + 0.17, y + h / 2, 0.04, fg);
  text(slide, label, { x: x + 0.28, y, w: w - 0.32, h, size, font: MONO, color: fg, bold: true, valign: "middle", spacing: 1 });
  return w;
}

// The KIRCHHOFF mark (web/components/shell/logo.tsx): three currents meeting at one junction.
function junctionMark(slide, x, y, size, o = {}) {
  const u = size / 32;
  const P = (px, py) => [x + px * u, y + py * u];
  if (o.frame !== false) panel(slide, x + 0.5 * u, y + 0.5 * u, 31 * u, 31 * u, { radius: 8 * u, fill: HEX.raised, line: HEX.wire, shadow: o.shadow !== false });
  const c = P(16, 16);
  const ends = [P(6.5, 8.5), P(25.5, 8.5), P(16, 26)];
  const wire = o.wireWidth || Math.max(1.5, size * 1.4);
  for (const e of ends) line(slide, e[0], e[1], c[0], c[1], { color: o.wireColor || HEX.fg, width: wire });
  for (const e of ends) dot(slide, e[0], e[1], 1.6 * u, o.endColor || HEX.muted);
  dot(slide, c[0], c[1], 3.4 * u, HEX.teal);
}

// ---------------------------------------------------------------------------------------------
// Layouts (pptxgenjs calls them slide masters; each becomes one slide layout).
// ---------------------------------------------------------------------------------------------

function defineLayouts(pres, bg, bgTitle) {
  const footer = (extra = []) => [
    { text: { text: "KIRCHHOFF", options: { x: MX, y: 6.98, w: 3, h: 0.25, fontFace: MONO, fontSize: 10, bold: true, color: HEX.subtle, charSpacing: 3, margin: 0 } } },
    ...extra,
  ];
  const slideNumber = { x: W - MX - 1.0, y: 6.98, w: 1.0, h: 0.25, fontFace: MONO, fontSize: 10, color: HEX.subtle, align: "right", margin: 0 };

  pres.defineSlideMaster({
    title: "KIRCHHOFF Title",
    background: { path: bgTitle },
    objects: [],
  });

  pres.defineSlideMaster({
    title: "KIRCHHOFF Content",
    background: { path: bg },
    objects: [
      {
        placeholder: {
          options: { name: "title", type: "title", ...TITLE_BOX, fontFace: SANS_SB, fontSize: 36, color: HEX.fg, margin: 0, align: "left", valign: "top" },
          text: "",
        },
      },
      ...footer(),
    ],
    slideNumber,
  });

  pres.defineSlideMaster({
    title: "KIRCHHOFF Media",
    background: { path: bg },
    objects: [],
    slideNumber,
  });
}

function kicker(slide, value) {
  text(slide, value, { x: MX, y: 0.52, w: 9, h: 0.26, font: MONO, size: 11, bold: true, color: HEX.teal, spacing: 3, valign: "middle", name: "Kicker" });
}

function contentSlide(pres, section, kickerText, title) {
  const slide = pres.addSlide({ masterName: "KIRCHHOFF Content", sectionTitle: section });
  kicker(slide, kickerText);
  // Geometry and style repeated on the slide so every renderer places the title identically.
  slide.addText(title, { placeholder: "title", ...TITLE_BOX, fontFace: SANS_SB, fontSize: 36, color: HEX.fg, align: "left", valign: "top", margin: 0, charSpacing: -0.5 });
  return slide;
}

// ---------------------------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------------------------

function slideTitle(pres) {
  pres.addSection({ title: "Open" });
  const s = pres.addSlide({ masterName: "KIRCHHOFF Title", sectionTitle: "Open" });

  text(s, "CROSS-CHAIN VERIFIER FOR CHAINLINK CCIP 2.0", { x: MX, y: 1.55, w: 8, h: 0.3, font: MONO, size: 12, bold: true, color: HEX.teal, spacing: 3 });
  text(s, "KIRCHHOFF", { x: MX - 0.04, y: 2.0, w: 8.4, h: 1.25, font: MONO, size: 80, bold: true, color: HEX.fg, spacing: 6, valign: "middle", lineSpacing: 1 });
  text(
    s,
    [
      { text: "Every bridge checks who signed.", options: { color: HEX.fg, breakLine: true } },
      { text: "We check if the money adds up.", options: { color: HEX.teal } },
    ],
    { x: MX, y: 3.7, w: 8.2, h: 1.25, font: SANS_SB, size: 32, lineSpacing: 1.08 }
  );
  text(s, "TOKEN2049 ORIGINS  ·  SINGAPORE  ·  OCTOBER 2026", { x: MX, y: 6.55, w: 8, h: 0.3, font: MONO, size: 11, color: HEX.subtle, spacing: 2 });

  // Focal art: the mark, large, with the law it encodes.
  junctionMark(s, 9.0, 1.7, 3.3, { wireWidth: 4 });
  text(s, "Σ in  =  Σ out", { x: 9.0, y: 5.2, w: 3.3, h: 0.42, font: MONO, size: 20, color: HEX.fg, align: "center", valign: "middle" });
  pill(s, "CONSERVED", 9.0 + (3.3 - 1.52) / 2, 5.78, "teal", { w: 1.52 });

  s.addNotes(
    "In April, one forged message created 292 million dollars from nothing. KIRCHHOFF is a Cross-Chain Verifier for Chainlink CCIP 2.0. Every bridge checks who signed. We check if the money adds up."
  );
}

function slideProblem(pres) {
  pres.addSection({ title: "Problem and insight" });
  const s = contentSlide(pres, "Problem and insight", "THE PROBLEM", "Bridges verify signatures. Nobody verifies supply");

  // Focal: the Kelp number.
  text(s, metric("kelpLoss"), { x: MX - 0.05, y: 1.85, w: 6.8, h: 1.75, font: SANS_SB, size: 120, color: HEX.rose, spacing: -3, valign: "middle", lineSpacing: 1 });
  text(
    s,
    [
      { text: `One forged message released about ${metric("kelpAmount")} from Kelp DAO's bridge on April 18, 2026.`, options: { superscript: false } },
      { text: "1", options: { superscript: true } },
      { text: " The bridge trusted a single verifier.", options: {} },
      { text: "2", options: { superscript: true } },
    ],
    { x: MX, y: 3.72, w: 6.4, h: 1.0, size: 18, color: HEX.muted, lineSpacing: 1.2 }
  );
  text(
    s,
    [
      { text: "Each of those bridges checked who signed.", options: { color: HEX.fg, breakLine: true } },
      { text: "None checked whether the money added up.", options: { color: HEX.fg } },
    ],
    { x: MX, y: 5.0, w: 6.95, h: 0.8, font: SANS_SB, size: 20, lineSpacing: 1.12 }
  );

  // Supporting stats.
  const sx = 7.75;
  const sw = W - MX - sx;
  const stat = (y, value, body, note, name) => {
    panel(s, sx, y, sw, 1.82, { name });
    text(s, value, { x: sx + 0.4, y: y + 0.28, w: sw - 0.8, h: 0.75, font: SANS_SB, size: 48, color: HEX.fg, spacing: -1, valign: "middle", lineSpacing: 1 });
    text(s, [{ text: body }, { text: note, options: { superscript: true } }], { x: sx + 0.4, y: y + 1.1, w: sw - 0.8, h: 0.55, size: 15, color: HEX.muted, lineSpacing: 1.15 });
  };
  stat(1.95, `${metric("kelpChains")} chains`, "where rsETH holders lost value without ever touching Kelp.", "3", "Stat chains");
  stat(4.0, metric("bridgeLosses2026"), `drained by bridge exploits across ${metric("bridgeIncidents2026")} incidents in 2026.`, "4", "Stat losses");

  text(s, "1  Crypto Times, May 18, 2026    2  Decrypt    3  Phemex, DeFi hacks 2026    4  DexTools / PeckShield, June 2026", {
    x: MX,
    y: 6.42,
    w: CW,
    h: 0.26,
    size: 10,
    color: HEX.subtle,
    font: MONO,
  });

  s.addNotes(
    "On April 18, attackers forged one LayerZero message and released about 116,500 rsETH, roughly 292 million dollars, from Kelp DAO's bridge. It passed because the bridge trusted a single verifier. Holders on 20 chains lost value without touching Kelp, and bridge exploits drained over 340 million dollars across 14 incidents this year. A simple sum would have exposed the fake supply the moment it appeared."
  );
}

function slideInsight(pres) {
  const s = contentSlide(pres, "Problem and insight", "THE INSIGHT", "Two laws, borrowed from Kirchhoff");

  const py = 1.95;
  const ph = 4.15;
  const pw = (CW - 0.4) / 2;
  const lx = MX;
  const rx = MX + pw + 0.4;

  // Junction Rule panel.
  panel(s, lx, py, pw, ph, { name: "Junction Rule" });
  text(s, "JUNCTION RULE  ·  PER MESSAGE", { x: lx + 0.4, y: py + 0.32, w: pw - 0.8, h: 0.26, font: MONO, size: 11, bold: true, color: HEX.teal, spacing: 2 });
  text(s, "Every credit has a debit", { x: lx + 0.4, y: py + 0.66, w: pw - 0.8, h: 0.45, font: SANS_SB, size: 22 });
  text(s, "Same message id, amount and recipient, finalized.", { x: lx + 0.4, y: py + 1.12, w: pw - 0.8, h: 0.28, size: 14, color: HEX.muted });

  const nodeW = 2.05;
  const nodeH = 0.74;
  const n1x = lx + 0.4;
  const n2x = lx + pw - 0.4 - nodeW;
  const node = (x, y, title, sub, tone) => {
    const edge = tone === "rose" ? HEX.roseDim : tone === "ghost" ? HEX.strong : HEX.tealDim;
    const fill = tone === "rose" ? HEX.roseInk : tone === "ghost" ? HEX.panel : HEX.raised;
    panel(s, x, y, nodeW, nodeH, { fill, line: edge, dash: tone === "ghost" ? "dash" : "solid", shadow: false, radius: 0.1 });
    text(s, title, { x: x + 0.16, y: y + 0.1, w: nodeW - 0.32, h: 0.24, font: MONO, size: 10, color: tone === "ghost" ? HEX.subtle : HEX.muted });
    text(s, sub, { x: x + 0.16, y: y + 0.36, w: nodeW - 0.32, h: 0.3, font: SANS_SB, size: 14, color: tone === "rose" ? HEX.rose : tone === "ghost" ? HEX.subtle : HEX.fg });
  };
  // Honest pair: burn on the source matches release on the destination.
  const r1 = py + 1.62;
  node(n1x, r1, "ARBITRUM · DEBIT", "burn 10 kETH", "teal");
  node(n2x, r1, "ETHEREUM · CREDIT", "release 10 kETH", "teal");
  line(s, n1x + nodeW + 0.08, r1 + nodeH / 2, n2x - 0.08, r1 + nodeH / 2, { color: HEX.teal, width: 1.75, arrow: true });
  text(s, "matched", { x: n1x + nodeW, y: r1 + 0.06, w: n2x - n1x - nodeW, h: 0.24, font: MONO, size: 10, color: HEX.teal, align: "center" });

  // The Kelp pattern: a credit with nothing behind it.
  const r2 = py + 2.62;
  node(n1x, r2, "NO SOURCE CHAIN", "no debit", "ghost");
  node(n2x, r2, "ETHEREUM · CREDIT", "release 116,500", "rose");
  line(s, n1x + nodeW + 0.08, r2 + nodeH / 2, n2x - 0.08, r2 + nodeH / 2, { color: HEX.rose, width: 1.75, dash: "dash", arrow: true });
  text(s, "forged", { x: n1x + nodeW, y: r2 + 0.06, w: n2x - n1x - nodeW, h: 0.24, font: MONO, size: 10, color: HEX.rose, align: "center" });
  pill(s, "DEBIT_NOT_FOUND", n2x + nodeW - 1.95, r2 + nodeH + 0.16, "rose", { w: 1.95, h: 0.28 });
  text(s, "Caught on the first transaction.", { x: lx + 0.4, y: r2 + nodeH + 0.16, w: 3.0, h: 0.28, size: 14, color: HEX.muted, valign: "middle" });

  // Loop Rule panel.
  panel(s, rx, py, pw, ph, { name: "Loop Rule" });
  text(s, "LOOP RULE  ·  ACROSS ALL CHAINS", { x: rx + 0.4, y: py + 0.32, w: pw - 0.8, h: 0.26, font: MONO, size: 11, bold: true, color: HEX.teal, spacing: 2 });
  text(s, "Backing covers every claim", { x: rx + 0.4, y: py + 0.66, w: pw - 0.8, h: 0.45, font: SANS_SB, size: 22 });

  // Claims converge into one junction: the home escrow.
  const cx = rx + pw / 2;
  const jy = py + 2.72;
  const claims = [
    { label: "Arbitrum", sym: "S₁", x: rx + 0.95 },
    { label: "Base", sym: "S₂", x: cx },
    { label: "In flight", sym: "F", x: rx + pw - 0.95 },
  ];
  const cy = py + 1.5;
  for (const c of claims) {
    line(s, c.x, cy + 0.3, cx, jy - 0.28, { color: HEX.strong, width: 1.5 });
  }
  for (const c of claims) {
    panel(s, c.x - 0.62, cy - 0.12, 1.24, 0.46, { fill: HEX.raised, line: HEX.strong, shadow: false, radius: 0.23 });
    text(s, [{ text: c.sym + " ", options: { fontFace: MONO, bold: true, color: HEX.fg } }, { text: c.label, options: { color: HEX.muted } }], {
      x: c.x - 0.62,
      y: cy - 0.12,
      w: 1.24,
      h: 0.46,
      size: 12,
      align: "center",
      valign: "middle",
    });
  }
  dot(s, cx, jy, 0.28, HEX.teal);
  text(s, "E", { x: cx - 0.28, y: jy - 0.28, w: 0.56, h: 0.56, font: MONO, bold: true, size: 16, color: HEX.base, align: "center", valign: "middle" });
  text(s, "home escrow", { x: cx + 0.4, y: jy - 0.13, w: 1.6, h: 0.26, font: MONO, size: 10, color: HEX.muted, valign: "middle" });

  text(s, "Δ = E − (ΣS + F) ≥ 0", { x: rx + 0.4, y: py + 3.15, w: pw - 0.8, h: 0.5, font: SANS_SB, size: 26, color: HEX.fg, align: "center", valign: "middle" });
  text(s, "Below zero, value was created from nothing.", { x: rx + 0.4, y: py + 3.66, w: pw - 0.8, h: 0.3, size: 14, color: HEX.muted, align: "center" });

  text(s, "One deterministic engine runs both rules in the CRE workflows, the CCV Judge and the backtester.", {
    x: MX,
    y: 6.32,
    w: CW,
    h: 0.3,
    size: 14,
    color: HEX.subtle,
  });

  s.addNotes(
    "Two rules, named after Kirchhoff's circuit laws. The Junction Rule is per message and exact: every mint or release must match one finalized burn or lock with the same message id, amount and recipient. A credit with no debit is forged, which catches the Kelp pattern on the first transaction. The Loop Rule is global: home escrow must cover the supply on every remote chain plus everything in flight. A deficit means value was created from nothing, whichever bridge did it."
  );
}

function slideDemo(pres, video) {
  pres.addSection({ title: "Demo" });
  const s = pres.addSlide({ masterName: "KIRCHHOFF Media", sectionTitle: "Demo" });
  kicker(s, "DEMO  ·  THE KELP REPLAY, REFUSED");

  const vw = 10.4;
  const vh = (vw * 9) / 16;
  const vx = (W - vw) / 2;
  const vy = 0.98;
  pill(s, "TESTNET SIMULATION", vx + vw - 2.05, 0.5, "violet", { w: 2.05, h: 0.3 });

  // Frame behind the video so it sits in a panel like the rest of the deck.
  panel(s, vx - 0.08, vy - 0.08, vw + 0.16, vh + 0.16, { radius: 0.16, fill: HEX.panel, line: HEX.wire, name: "Video frame" });

  if (video.embedded) {
    s.addMedia({ type: "video", path: VIDEO, x: vx, y: vy, w: vw, h: vh, cover: dataUri(video.poster), objectName: "Demo video" });
  } else {
    s.addImage({ path: video.poster, x: vx, y: vy, w: vw, h: vh, objectName: "Demo placeholder frame", altText: "Placeholder for the demo recording" });
    const cx = vx + vw / 2;
    const cy = vy + vh / 2 - 0.25;
    dot(s, cx, cy, 0.5, HEX.base, { ring: true, ringColor: HEX.teal, ringWidth: 1.5 });
    s.addShape("triangle", { x: cx - 0.13, y: cy - 0.18, w: 0.36, h: 0.36, rotate: 90, fill: { color: HEX.teal }, line: { type: "none" }, objectName: "Play glyph" });
    text(s, "Demo recording", { x: vx, y: cy + 0.72, w: vw, h: 0.42, font: SANS_SB, size: 22, align: "center", valign: "middle" });
    text(s, "Rebuild the deck once media/video/kirchhoff-demo.mp4 exists to embed it here.", { x: vx, y: cy + 1.16, w: vw, h: 0.3, size: 14, color: HEX.muted, align: "center" });
  }

  s.addNotes(
    "Play the recording. 0:15 kETH on three chains, a normal CCIP transfer passes. 0:35 the Kelp attack on a bridge with a single verifier. 1:05 in the same CRE run, KIRCHHOFF finds a credit with no debit and writes BREACH on all three chains. 1:25 the attacker tries to spread it through CCIP and is refused. 1:50 he cannot move it, and nobody will lend against it. 2:05 on-call gets the whole story in one screen. Everything shown is a testnet simulation."
  );
}

function slideArchitecture(pres) {
  pres.addSection({ title: "Product" });
  const s = contentSlide(pres, "Product", "HOW IT WORKS", "Consensus reads in, signed verdicts out");

  const top = 1.95;
  const colH = 3.25;
  const colW = 3.5;
  const gap = (CW - 3 * colW) / 2;
  const c1 = MX;
  const c2 = MX + colW + gap;
  const c3 = MX + 2 * (colW + gap);

  const header = (x, label, sub, color) => {
    text(s, label, { x: x + 0.3, y: top + 0.24, w: colW - 0.6, h: 0.24, font: MONO, size: 10, bold: true, color, spacing: 2 });
    text(s, sub, { x: x + 0.3, y: top + 0.5, w: colW - 0.6, h: 0.32, font: SANS_SB, size: 16 });
  };
  const row = (x, y, lead, title, sub, o = {}) => {
    panel(s, x + 0.2, y, colW - 0.4, 0.5, { fill: o.fill || HEX.raised, line: o.edge || HEX.wire, shadow: false, radius: 0.08 });
    if (lead) text(s, lead, { x: x + 0.36, y: y + 0.07, w: 0.4, h: 0.22, font: MONO, size: 11, bold: true, color: o.leadColor || HEX.teal });
    const tx = lead ? x + 0.78 : x + 0.36;
    const tw = colW - 0.4 - (tx - x - 0.2) - 0.14;
    text(s, title, { x: tx, y: y + 0.06, w: tw, h: 0.22, size: 14, font: SANS_SB, color: o.titleColor || HEX.fg, valign: "middle" });
    text(s, sub, { x: tx, y: y + 0.28, w: tw, h: 0.18, size: 10, color: HEX.subtle, font: MONO, valign: "middle" });
  };

  // 1. CRE Conservation Engine.
  panel(s, c1, top, colW, colH, { name: "CRE Conservation Engine" });
  header(c1, "CHAINLINK CRE", "Conservation Engine", HEX.teal);
  const rows = [
    ["W1", "Junction Watch", "credit to debit, same run"],
    ["W2", "Loop Ledger", "Δ on all chains, 30 s cron"],
    ["W3", "Responder", "quarantine on breach"],
    ["W4", "Topology Watch", "unlisted minters, spec"],
  ];
  rows.forEach((r, i) => row(c1, top + 1.0 + i * 0.56, r[0], r[1], r[2]));

  // 2. Onchain, every chain (focal).
  panel(s, c2, top, colW, colH, { line: HEX.tealDim, lineWidth: 1.25, name: "Onchain ledger and feed" });
  header(c2, "ONCHAIN  ·  EVERY CHAIN", "Ledger, Feed, Quarantine", HEX.teal);
  const chains = [
    ["Ethereum Sepolia", "home  ·  escrow, Registry"],
    ["Arbitrum Sepolia", "remote  ·  burn-mint pool"],
    ["Base Sepolia", "remote  ·  burn-mint pool"],
  ];
  chains.forEach((c, i) => {
    const y = top + 1.0 + i * 0.75;
    panel(s, c2 + 0.2, y, colW - 0.4, 0.62, { fill: HEX.raised, line: HEX.wire, shadow: false, radius: 0.08 });
    dot(s, c2 + 0.42, y + 0.2, 0.05, HEX.teal);
    text(s, c[0], { x: c2 + 0.58, y: y + 0.08, w: colW - 1.0, h: 0.24, size: 14, font: SANS_SB, valign: "middle" });
    text(s, c[1], { x: c2 + 0.58, y: y + 0.34, w: colW - 1.0, h: 0.2, size: 10, font: MONO, color: HEX.subtle, valign: "middle" });
  });

  // 3. CCIP 2.0 enforcement.
  panel(s, c3, top, colW, colH, { name: "CCIP 2.0 enforcement" });
  header(c3, "CHAINLINK CCIP 2.0", "Enforcement", HEX.teal);
  row(c3, top + 1.0, "", "CCV cell + Judge", "POST /v1/evaluate");
  row(c3, top + 1.56, "", "Fallback B: TokenPool", "KirchhoffTokenPool, live", { fill: HEX.tealInk, edge: HEX.tealDim, titleColor: HEX.teal });
  row(c3, top + 2.12, "", "Committee Verifier", "Chainlink, signs as well");
  text(s, "Both must sign to execute", { x: c3 + 0.3, y: top + 2.74, w: colW - 0.6, h: 0.26, size: 10, font: MONO, color: HEX.muted });

  // Wires between the columns.
  const gx1 = c1 + colW;
  const gx2 = c2 + colW;
  line(s, c2 - 0.06, top + 1.45, gx1 + 0.06, top + 1.45, { color: HEX.teal, width: 1.5, arrow: true });
  text(s, "reads", { x: gx1, y: top + 1.14, w: gap, h: 0.24, font: MONO, size: 10, color: HEX.teal, align: "center" });
  line(s, gx1 + 0.06, top + 2.35, c2 - 0.06, top + 2.35, { color: HEX.teal, width: 1.5, arrow: true });
  text(s, "reports", { x: gx1 - 0.1, y: top + 2.04, w: gap + 0.2, h: 0.24, font: MONO, size: 10, color: HEX.teal, align: "center" });
  line(s, c3 - 0.06, top + 1.9, gx2 + 0.06, top + 1.9, { color: HEX.teal, width: 1.5, arrow: true });
  text(s, "status", { x: gx2, y: top + 1.59, w: gap, h: 0.24, font: MONO, size: 10, color: HEX.teal, align: "center" });

  // 4. Control plane, outside the veto path.
  const cpY = 5.62;
  const cpH = 1.08;
  line(s, c2 + colW / 2, top + colH + 0.04, c2 + colW / 2, cpY - 0.04, { color: HEX.strong, width: 1.25, dash: "dash", arrow: true });
  text(s, "events", { x: c2 + colW / 2 + 0.1, y: top + colH + 0.04, w: 0.8, h: 0.3, font: MONO, size: 10, color: HEX.subtle, valign: "middle" });
  panel(s, MX, cpY, CW, cpH, { fill: HEX.base, fillTransparency: 30, line: HEX.strong, dash: "dash", shadow: false, name: "Control plane" });
  text(s, "CONTROL PLANE  ·  OUTSIDE THE VETO PATH", { x: MX + 0.3, y: cpY + 0.2, w: 6, h: 0.24, font: MONO, size: 10, bold: true, color: HEX.subtle, spacing: 2 });
  let px = MX + 0.3;
  for (const chip of ["Indexer", "API", "Mission Control", "MCP", "AI: Copilot, Narrator"]) {
    const w = 0.36 + chip.length * 0.088;
    panel(s, px, cpY + 0.55, w, 0.34, { fill: HEX.panel, line: HEX.wire, shadow: false, radius: 0.17 });
    text(s, chip, { x: px, y: cpY + 0.55, w, h: 0.34, size: 12, color: HEX.muted, align: "center", valign: "middle" });
    px += w + 0.14;
  }
  text(s, "It can go dark. Every verdict still works.", { x: W - MX - 4.6, y: cpY + 0.52, w: 4.3, h: 0.4, size: 16, font: SANS_SB, color: HEX.fg, align: "right", valign: "middle" });

  s.addNotes(
    "Four layers. The CRE Conservation Engine reads every chain with DON consensus and writes signed reports to a ConservationLedger and Conservation Feed on every chain. CCIP 2.0 enforces: each CCV cell runs our Judge as its policy hook, and our KirchhoffTokenPool, Fallback B, reverts transfers of a broken token at execution time. The Chainlink Committee Verifier still signs every message. The control plane, the UI, API and AI, only mirrors onchain state and can go offline without changing a single verdict."
  );
}

function slideWhyChainlink(pres) {
  const s = contentSlide(pres, "Product", "WHY CHAINLINK", "CCIP 2.0 opened the slot. CRE makes it trustless");

  // Left: both signatures required.
  const top = 1.98;
  const mx = MX;
  const node = (x, y, w, h, eyebrow, title, color, edge, fill) => {
    panel(s, x, y, w, h, { fill: fill || HEX.panel, line: edge || HEX.wire, radius: 0.12 });
    text(s, eyebrow, { x: x + 0.22, y: y + 0.14, w: w - 0.44, h: 0.22, font: MONO, size: 10, bold: true, color, spacing: 1 });
    text(s, title, { x: x + 0.22, y: y + 0.4, w: w - 0.44, h: 0.3, size: 15, font: SANS_SB });
  };
  const msgY = top + 0.9;
  node(mx, msgY, 1.55, 0.86, "CCIP", "Message", HEX.muted);
  const vx = mx + 2.1;
  const vw = 2.55;
  node(vx, top, vw, 0.86, "COMMITTEE VERIFIER", "Who signed?", HEX.blue, HEX.blueDim);
  node(vx, top + 1.8, vw, 0.86, "KIRCHHOFF CCV", "Does it add up?", HEX.teal, HEX.tealDim, HEX.tealInk);
  const ex = vx + vw + 0.55;
  node(ex, msgY, 1.55, 0.86, "EXECUTOR", "Executes", HEX.teal);
  line(s, mx + 1.55 + 0.05, msgY + 0.43, vx - 0.05, top + 0.43, { color: HEX.strong, width: 1.5, arrow: true });
  line(s, mx + 1.55 + 0.05, msgY + 0.43, vx - 0.05, top + 1.8 + 0.43, { color: HEX.strong, width: 1.5, arrow: true });
  line(s, vx + vw + 0.05, top + 0.43, ex - 0.05, msgY + 0.43, { color: HEX.strong, width: 1.5, arrow: true });
  line(s, vx + vw + 0.05, top + 1.8 + 0.43, ex - 0.05, msgY + 0.43, { color: HEX.teal, width: 1.5, arrow: true });

  // Right: three reasons.
  const rx = 7.75;
  const rw = W - MX - rx;
  const reasons = [
    ["CCIP 2.0  ·  LIVE SINCE SEPT 28, 2026", "An issuer can require its own CCV. Verifiers set their own fee in an open marketplace."],
    ["CRE  ·  DON CONSENSUS", "W1 to W4 read three chains at pinned finalized blocks and write signed reports onchain."],
    ["BESIDE, NEVER INSTEAD", "We never replace the Committee Verifier. Our FAIL withholds a signature; it never forges one."],
  ];
  reasons.forEach((r, i) => {
    const y = top + i * 0.95;
    text(s, r[0], { x: rx, y, w: rw, h: 0.22, font: MONO, size: 10, bold: true, color: HEX.teal, spacing: 1 });
    text(s, r[1], { x: rx, y: y + 0.27, w: rw, h: 0.56, size: 14, color: HEX.fg, lineSpacing: 1.15 });
  });

  // Measured proof.
  const proofY = 4.95;
  const cells = [
    [metric("creScenarios"), "PRD scenarios, CRE simulate"],
    [metric("w2Reads"), "CRE reads per W2 run"],
    [metric("judgeP99Stub"), "Judge p99, 100 rps, stub RPCs"],
    [metric("engineBranches"), "engine branches covered"],
  ];
  const cg = 0.2;
  const cw = (CW - 3 * cg) / 4;
  cells.forEach((c, i) => {
    const x = MX + i * (cw + cg);
    panel(s, x, proofY, cw, 0.84, { fill: HEX.panel, line: HEX.wire, shadow: false, radius: 0.1 });
    text(s, c[0], { x: x + 0.22, y: proofY + 0.1, w: cw - 0.44, h: 0.38, font: MONO, size: 20, bold: true, valign: "middle" });
    text(s, c[1], { x: x + 0.22, y: proofY + 0.5, w: cw - 0.44, h: 0.22, size: 10.5, color: HEX.muted });
  });

  // Honest status.
  const stY = 5.96;
  panel(s, MX, stY, CW, 0.76, { fill: HEX.violetInk, line: HEX.violetDim, shadow: false, radius: 0.12, name: "Status today" });
  pill(s, "STATUS TODAY", MX + 0.25, stY + 0.24, "violet", { w: 1.62 });
  text(
    s,
    "Live CCV attestation onboarding is pending, so Fallback B (KirchhoffTokenPool) enforces live on CCIP testnet lanes. CRE deploy access is pending, so W1 to W4 run via cre workflow simulate.",
    { x: MX + 2.1, y: stY + 0.09, w: CW - 2.35, h: 0.58, size: 14, color: HEX.fg, valign: "middle", lineSpacing: 1.1 }
  );

  s.addNotes(
    "CCIP 2.0 launched on September 28 and lets an issuer require its own Cross-Chain Verifier: both the Committee Verifier and ours must sign before a message executes. CRE gives us DON consensus reads across chains, so no single RPC or operator can produce a verdict. We sit beside the Committee Verifier and never replace it. Honest status: live CCV attestation onboarding is pending, so our KirchhoffTokenPool enforces live on CCIP testnet lanes, and CRE deploy access is pending, so the four workflows run through cre workflow simulate."
  );
}

function slideBusiness(pres) {
  pres.addSection({ title: "Business and roadmap" });
  const s = contentSlide(pres, "Business and roadmap", "BUSINESS", "Paid per message, per token, per market");

  const top = 1.98;
  const gap = 0.3;
  const cw = (CW - 2 * gap) / 3;
  const cards = [
    ["PER MESSAGE", "CCV verification fee", "Our fee on top of the CCIP base fee, collected by CCIP on every protected transfer."],
    ["PER TOKEN", "Issuer subscription", "Monitoring, Incident Room, Spec Copilot onboarding, backtests and on-call paging."],
    ["PER MARKET", "Conservation Feed", "AggregatorV3-compatible. Free public feed, paid SLA tier for lending markets."],
  ];
  cards.forEach((c, i) => {
    const x = MX + i * (cw + gap);
    panel(s, x, top, cw, 2.65, { name: c[1] });
    text(s, String(i + 1).padStart(2, "0"), { x: x + 0.4, y: top + 0.3, w: 1, h: 0.5, font: MONO, size: 28, bold: true, color: HEX.teal, valign: "middle" });
    text(s, c[0], { x: x + 0.4, y: top + 0.92, w: cw - 0.8, h: 0.22, font: MONO, size: 10, bold: true, color: HEX.muted, spacing: 2 });
    text(s, c[1], { x: x + 0.4, y: top + 1.2, w: cw - 0.8, h: 0.4, font: SANS_SB, size: 20 });
    text(s, c[2], { x: x + 0.4, y: top + 1.64, w: cw - 0.8, h: 0.75, size: 14, color: HEX.muted, lineSpacing: 1.15 });
  });

  // First customers and the wedge.
  const by = 4.92;
  text(s, "FIRST CUSTOMERS", { x: MX, y: by, w: 4, h: 0.24, font: MONO, size: 10, bold: true, color: HEX.teal, spacing: 2 });
  let px = MX;
  for (const chip of ["Liquid restaking (LRT)", "Liquid staking (LST)", "Wrapped BTC"]) {
    const w = 0.5 + chip.length * 0.095;
    panel(s, px, by + 0.38, w, 0.42, { fill: HEX.raised, line: HEX.strong, shadow: false, radius: 0.21 });
    text(s, chip, { x: px, y: by + 0.38, w, h: 0.42, size: 14, align: "center", valign: "middle" });
    px += w + 0.16;
  }
  text(s, "Tokens that cross many chains and bridges. Kelp said in May it was moving rsETH to CCIP.", {
    x: MX,
    y: by + 0.98,
    w: 6.6,
    h: 0.5,
    size: 14,
    color: HEX.muted,
    lineSpacing: 1.15,
  });

  const wx = 7.75;
  const ww = W - MX - wx;
  text(s, "WEDGE", { x: wx, y: by, w: ww, h: 0.24, font: MONO, size: 10, bold: true, color: HEX.teal, spacing: 2 });
  text(s, "Free shadow mode and a public status page. Holders ask why their token is not on it.", {
    x: wx,
    y: by + 0.36,
    w: ww,
    h: 0.7,
    size: 16,
    font: SANS_SB,
    lineSpacing: 1.15,
  });
  text(s, "Pricing is a hypothesis to validate with design partners.", { x: wx, y: by + 1.2, w: ww, h: 0.26, size: 12, color: HEX.subtle });

  text(s, "Sources: Chainlink, Introducing CCIP 2.0 (verifier fees)  ·  Unchained (Kelp moving rsETH to CCIP)", { x: MX, y: 6.56, w: CW, h: 0.24, size: 10, color: HEX.subtle, font: MONO });

  s.addNotes(
    "Three revenue lines. A CCV verification fee per protected message, which CCIP 2.0 lets third-party verifiers set on top of the base fee. An issuer subscription for monitoring, the Incident Room, Spec Copilot onboarding and backtests. And the Conservation Feed: free and public, with a paid SLA tier for lending markets. First customers are multi-chain LRT, LST and wrapped BTC issuers. The wedge is free shadow mode with a public status page. Pricing is a hypothesis we will validate with design partners."
  );
}

function slideRoadmap(pres) {
  const s = contentSlide(pres, "Business and roadmap", "LIMITS AND ROADMAP", "What we do not catch, and what ships next");

  const top = 1.98;
  const lw = 4.55;
  const rx = MX + lw + 0.3;
  const rw = W - MX - rx;
  const topH = 2.7;

  // Limits.
  panel(s, MX, top, lw, topH, { name: "Limits" });
  text(s, "WE DO NOT PROTECT AGAINST", { x: MX + 0.35, y: top + 0.3, w: lw - 0.7, h: 0.22, font: MONO, size: 10, bold: true, color: HEX.rose, spacing: 2 });
  const limits = [
    "Theft that keeps supply conserved, like a drained admin vault",
    "DEX price manipulation, phishing, lending bugs",
    "Same-block swaps after a forged release, without KirchhoffGuard",
  ];
  limits.forEach((l, i) => {
    const y = top + 0.68 + i * 0.64;
    dot(s, MX + 0.42, y + 0.13, 0.05, HEX.rose);
    text(s, l, { x: MX + 0.62, y, w: lw - 0.97, h: 0.56, size: 14, color: HEX.fg, lineSpacing: 1.12 });
  });

  // Roadmap timeline.
  panel(s, rx, top, rw, topH, { name: "Roadmap" });
  text(s, "ROADMAP", { x: rx + 0.35, y: top + 0.3, w: 2, h: 0.22, font: MONO, size: 10, bold: true, color: HEX.teal, spacing: 2 });
  const phases = [
    ["Harden", "WEEKS 1 TO 4", "Audit booked, 2 design partners"],
    ["Shadow", "MONTHS 2 TO 3", "60 days, zero false BROKEN"],
    ["Enforce", "MONTHS 4 TO 6", "4-cell committee, first enforced token"],
    ["Feed", "MONTHS 6 TO 9", "3 money markets read it"],
    ["Institutional", "MONTHS 9 TO 12", "First institutional issuer"],
  ];
  const colW = (rw - 0.5) / phases.length;
  const wireY = top + 1.14;
  const nodeX = (i) => rx + 0.25 + colW * i + colW / 2;
  line(s, nodeX(0), wireY, nodeX(1), wireY, { color: HEX.teal, width: 2 });
  line(s, nodeX(1), wireY, nodeX(4), wireY, { color: HEX.strong, width: 1.5 });
  // Bracket for the next 90 days.
  const bx = nodeX(0) - colW / 2 + 0.08;
  const bw = colW * 2 - 0.16;
  panel(s, bx, top + 0.62, bw, 1.93, { fill: HEX.tealInk, fillTransparency: 35, line: HEX.tealDim, shadow: false, radius: 0.12 });
  text(s, "NEXT 90 DAYS", { x: bx, y: top + 0.7, w: bw, h: 0.22, font: MONO, size: 10, bold: true, color: HEX.teal, align: "center", spacing: 2 });
  phases.forEach((p, i) => {
    const near = i < 2;
    const cx = nodeX(i);
    dot(s, cx, wireY, 0.11, near ? HEX.teal : HEX.panel, near ? {} : { ring: true, ringColor: HEX.strong, ringWidth: 1.5 });
    const tx = cx - colW / 2 + 0.06;
    const tw = colW - 0.12;
    text(s, p[0], { x: tx, y: wireY + 0.26, w: tw, h: 0.3, size: 15, font: SANS_SB, color: near ? HEX.fg : HEX.muted, align: "center" });
    text(s, p[1], { x: tx, y: wireY + 0.58, w: tw, h: 0.22, size: 10, font: MONO, color: near ? HEX.teal : HEX.subtle, align: "center" });
    text(s, p[2], { x: tx, y: wireY + 0.84, w: tw, h: 0.52, size: 11, color: near ? HEX.muted : HEX.subtle, align: "center", lineSpacing: 1.08 });
  });

  // Team and ask.
  const by = top + topH + 0.25;
  const bh = 6.72 - by;
  panel(s, MX, by, lw, bh, { name: "Team" });
  text(s, "TEAM", { x: MX + 0.35, y: by + 0.26, w: 2, h: 0.22, font: MONO, size: 10, bold: true, color: HEX.muted, spacing: 2 });
  const team = TEAM.filter((t) => t.name !== PENDING);
  if (team.length > 0) {
    text(
      s,
      team.map((t, i) => ({ text: `${t.name}`, options: { bold: true, breakLine: false } })).flatMap((r, i) => [r, { text: team[i].role === PENDING ? "" : `  ${team[i].role}`, options: { color: HEX.muted, breakLine: i < team.length - 1 } }]),
      { x: MX + 0.35, y: by + 0.58, w: lw - 0.7, h: bh - 0.75, size: 14 }
    );
  } else {
    text(s, "Built in 36 hours at TOKEN2049", { x: MX + 0.35, y: by + 0.56, w: lw - 0.7, h: 0.3, size: 15, font: SANS_SB });
    text(s, [{ text: `${metric("prdDone")} PRD requirements done`, options: { breakLine: true } }, { text: `${metric("testsFoundry")} Foundry + ${metric("testsTs")} TypeScript tests pass` }], {
      x: MX + 0.35,
      y: by + 0.94,
      w: lw - 0.7,
      h: 0.75,
      size: 14,
      color: HEX.muted,
      lineSpacing: 1.12,
    });
  }

  panel(s, rx, by, rw, bh, { fill: HEX.tealInk, line: HEX.tealDim, name: "Ask" });
  text(s, "THE ASK", { x: rx + 0.35, y: by + 0.26, w: 2, h: 0.22, font: MONO, size: 10, bold: true, color: HEX.teal, spacing: 2 });
  const asks = [
    ["Chainlink", "CCV marketplace onboarding, CRE deploy access"],
    ["Issuers", "2 design partners: LRT, LST, wrapped BTC"],
    ["Lending markets", "read the feed, freeze on BROKEN"],
  ];
  asks.forEach((a, i) => {
    const y = by + 0.6 + i * 0.36;
    text(s, [{ text: a[0] + "  ", options: { fontFace: SANS_SB, color: HEX.teal } }, { text: a[1], options: { color: HEX.fg } }], { x: rx + 0.35, y, w: rw - 0.7, h: 0.32, size: 15, valign: "middle" });
  });

  s.addNotes(
    "We name our limits. KIRCHHOFF does not catch theft that keeps supply conserved, like a drained admin vault, nor price manipulation, phishing or lending bugs, and it cannot undo the first release on a bridge it does not sit on; it contains it within one CRE run. Next 90 days: harden, book an audit, sign two issuer design partners, then run shadow mode on mainnet until we show 60 days with zero false BROKEN. Then enforcement with a 4-cell committee, the feed in money markets, and institutional issuers. Our ask: CCV marketplace onboarding and CRE deploy access from Chainlink, two issuer design partners, and lending markets that read the feed."
  );
}

// ---------------------------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  const bg = path.join(BUILD, "bg.png");
  const bgTitle = path.join(BUILD, "bg-title.png");
  await backgroundPng(bg, { fadeX: 0.5, fadeY: 0.0, ax: 0.08, ay: -0.05, ar: 0.55, aOpacity: 0.09 });
  await backgroundPng(bgTitle, { fadeX: 0.78, fadeY: 0.45, ax: 0.78, ay: 0.45, ar: 0.42, aOpacity: 0.13 });

  const video = { embedded: false, poster: path.join(BUILD, "poster.png") };
  if (fs.existsSync(VIDEO)) {
    const { seconds, codec } = probeVideo(VIDEO);
    if (codec !== "h264") console.warn(`warning: ${VIDEO} is ${codec}; PowerPoint plays H.264 MP4 most reliably`);
    METRICS.demoDuration.value = `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
    posterFrame(VIDEO, video.poster, seconds);
    video.embedded = true;
  } else {
    await placeholderFrame(video.poster);
  }

  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  pres.title = "KIRCHHOFF";
  pres.subject = "Conservation verifier for Chainlink CCIP 2.0, TOKEN2049 Origins stage deck";
  pres.author = "KIRCHHOFF";
  pres.company = "KIRCHHOFF";
  pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
  defineLayouts(pres, bg, bgTitle);

  slideTitle(pres);
  slideProblem(pres);
  slideInsight(pres);
  slideDemo(pres, video);
  slideArchitecture(pres);
  slideWhyChainlink(pres);
  slideBusiness(pres);
  slideRoadmap(pres);

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);

  console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
  console.log(video.embedded ? `slide 4: embedded ${path.relative(ROOT, VIDEO)} (${METRICS.demoDuration.value})` : `slide 4: placeholder frame (${path.relative(ROOT, VIDEO)} not found)`);
  const pending = Object.entries(METRICS).filter(([, m]) => m.value === PENDING);
  if (TEAM.some((t) => t.name === PENDING)) pending.push(["team", { source: "TEAM in media/deck/build.cjs (names not recorded in the repo)" }]);
  if (pending.length > 0) {
    console.log(`\n${pending.length} items ${PENDING} (not on any slide):`);
    for (const [k, m] of pending) console.log(`  ${k.padEnd(22)} ${m.source}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
