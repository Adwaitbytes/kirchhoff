/**
 * The Kirchhoff junction as a glass object: the product mark built in porcelain and glass. A beveled
 * porcelain face holds a stack of smoked-mint glass cassettes; inside the aperture floats a beveled
 * glass Y (the logo's three ports) with current channels glowing through it. Three wires run in from
 * the chain cards and through grommets in the frame; current bands flow along them into the core and
 * out of the bottom port. Every ~10s a forged rose pulse rides the WeakBridge wire, is refused at a
 * glass barrier and flares rose. Vanilla three.js, loaded lazily by the landing only. Reduced motion
 * renders one settled frame and never animates.
 */
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  LinearFilter,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Quaternion,
  Scene,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Timer,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface JunctionOptions {
  canvas: HTMLCanvasElement;
  theme: "light" | "dark";
  reducedMotion: boolean;
  motionScale: number;
  /** Called once the first frame is on screen, so the poster can fade out. */
  onReady: () => void;
}

export interface JunctionHandle {
  dispose: () => void;
  setPointer: (x: number, y: number) => void;
  setVisible: (visible: boolean) => void;
}

const MINT = new Color("#7fdcae");
const ROSE = new Color("#f43f5e");
const FORGE_EVERY = 10;
const FORGE_FIRST = 4.2;
const FORGE_TRAVEL = 1.7;
const FLASH = 0.9;
const INTRO = 2.6;
/** Resting three-quarter view: enough yaw to read the stacked glass, not so much the Y foreshortens. */
const REST_YAW = 0.42;
const REST_PITCH = 0.06;

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const easeOutBack = (t: number) => {
  const x = clamp01(t) - 1;
  return 1 + 2.2 * x ** 3 + 1.2 * x ** 2;
};

function roundedRect(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** A beveled ring: rounded square with a rounded aperture, centered on z = 0. */
function frameGeometry(outer: number, inner: number, depth: number, bevel: number): ExtrudeGeometry {
  const shape = roundedRect(outer, outer, outer * 0.2);
  shape.holes.push(roundedRect(inner, inner, inner * 0.14));
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: 10, bevelSize: bevel, bevelThickness: bevel, curveSegments: 40 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/**
 * The logo's Y as one closed outline: three arms with round caps, joined at the inner corners where
 * neighbouring arm edges meet. Arms are given as directions (radians) and lengths from the center.
 */
function yShape(arms: { angle: number; length: number }[], halfWidth: number): Shape {
  const sorted = [...arms].sort((a, b) => a.angle - b.angle);
  const s = new Shape();
  const corner = (a: number, b: number) => {
    const gap = (b - a + Math.PI * 2) % (Math.PI * 2);
    const mid = a + gap / 2;
    const d = halfWidth / Math.sin(gap / 2);
    return new Vector2(Math.cos(mid) * d, Math.sin(mid) * d);
  };
  sorted.forEach((arm, i) => {
    const prev = sorted[(i + sorted.length - 1) % sorted.length]!;
    const start = corner(prev.angle, arm.angle);
    if (i === 0) s.moveTo(start.x, start.y);
    else s.lineTo(start.x, start.y);
    const dir = new Vector2(Math.cos(arm.angle), Math.sin(arm.angle));
    const right = new Vector2(dir.y, -dir.x);
    const end = dir.clone().multiplyScalar(arm.length);
    const a0 = end.clone().addScaledVector(right, halfWidth);
    s.lineTo(a0.x, a0.y);
    // Round cap: half circle from the right edge round to the left edge.
    s.absarc(end.x, end.y, halfWidth, arm.angle - Math.PI / 2, arm.angle + Math.PI / 2, false);
  });
  s.closePath();
  return s;
}

/** Radial falloff sprite, drawn once: the glow on pulses, the core and the barrier flare. */
function glowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.22, "rgba(255,255,255,0.55)");
    grd.addColorStop(0.55, "rgba(255,255,255,0.12)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Soft elliptical contact shadow, drawn once into a canvas texture. */
function shadowTexture(dark: boolean): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  if (g) {
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, dark ? "rgba(0,0,0,0.6)" : "rgba(22,58,44,0.34)");
    grd.addColorStop(0.45, dark ? "rgba(0,0,0,0.24)" : "rgba(22,58,44,0.12)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** A broad, feathered softbox baked into the room environment, so glass and glaze get one clean highlight. */
function softboxTexture(): DataTexture {
  const w = 128;
  const h = 32;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x / (w - 1)) * 2 - 1;
      const ny = (y / (h - 1)) * 2 - 1;
      const k = (y * w + x) * 4;
      px[k] = 255;
      px[k + 1] = 255;
      px[k + 2] = 255;
      px[k + 3] = Math.round(255 * Math.exp(-2 * nx * nx - 3 * ny * ny) * (1 - nx * nx) ** 2 * (1 - ny * ny) ** 2);
    }
  }
  const t = new DataTexture(px, w, h);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Current flowing along a tube: comet-shaped bands travel toward u = 1 at a fixed world speed, over a
 * dim base. A rose band (the forgery) can ride on top. Shaded with a soft rim so the wire reads round.
 */
function currentMaterial(base: Color, hot: Color, spacing: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLength: { value: 1 },
      uSpacing: { value: spacing },
      uOn: { value: 1 },
      uBase: { value: base.clone() },
      uHot: { value: hot.clone() },
      uRose: { value: ROSE.clone().multiplyScalar(2.2) },
      uForgeU: { value: -1 },
      uForgeMix: { value: 0 },
      uTint: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLength, uSpacing, uOn, uForgeU, uForgeMix, uTint;
      uniform vec3 uBase, uHot, uRose;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float p = fract(uTime * 0.9 / uSpacing - vUv.x * uLength / uSpacing);
        float comet = pow(1.0 - p, 7.0) * smoothstep(0.0, 0.02, p) + smoothstep(0.03, 0.0, p);
        vec3 hot = mix(uHot, uRose, uTint);
        vec3 col = mix(uBase, hot, clamp(0.06 * uOn + comet * uOn, 0.0, 1.0));
        col += hot * comet * uOn * 0.9;
        float d = (vUv.x - uForgeU) * uLength;
        float forge = exp(-d * d * 60.0) * uForgeMix + exp(-max(d, 0.0) * 1.2) * step(d, 0.0) * step(0.0, uForgeU) * 0.35 * uForgeMix;
        col = mix(col, uRose, clamp(forge, 0.0, 1.0));
        col *= 0.72 + 0.28 * facing;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/** A tube whose vertices are rewritten in place each frame, for wires that follow the moving object. */
class LiveTube {
  readonly geometry = new BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly p = new Vector3();
  private readonly n = new Vector3();

  constructor(
    private readonly segments: number,
    private readonly radial: number,
    private readonly radius: number,
  ) {
    const count = (segments + 1) * (radial + 1);
    this.pos = new Float32Array(count * 3);
    this.nor = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const index: number[] = [];
    for (let i = 0; i <= segments; i += 1) {
      for (let j = 0; j <= radial; j += 1) {
        const k = i * (radial + 1) + j;
        uv[k * 2] = i / segments;
        uv[k * 2 + 1] = j / radial;
        if (i < segments && j < radial) {
          const a = k;
          const b = k + radial + 1;
          index.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    }
    this.geometry.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute("normal", new BufferAttribute(this.nor, 3));
    this.geometry.setAttribute("uv", new BufferAttribute(uv, 2));
    this.geometry.setIndex(index);
  }

  write(curve: CatmullRomCurve3) {
    curve.updateArcLengths();
    const frames = curve.computeFrenetFrames(this.segments, false);
    for (let i = 0; i <= this.segments; i += 1) {
      curve.getPointAt(i / this.segments, this.p);
      const N = frames.normals[i]!;
      const B = frames.binormals[i]!;
      for (let j = 0; j <= this.radial; j += 1) {
        const a = (j / this.radial) * Math.PI * 2;
        this.n.set(0, 0, 0).addScaledVector(N, Math.cos(a)).addScaledVector(B, Math.sin(a));
        const k = (i * (this.radial + 1) + j) * 3;
        this.nor[k] = this.n.x;
        this.nor[k + 1] = this.n.y;
        this.nor[k + 2] = this.n.z;
        this.pos[k] = this.p.x + this.n.x * this.radius;
        this.pos[k + 1] = this.p.y + this.n.y * this.radius;
        this.pos[k + 2] = this.p.z + this.n.z * this.radius;
      }
    }
    (this.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.normal as BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }
}

export function mountJunction({ canvas, theme, reducedMotion, motionScale, onReady }: JunctionOptions): JunctionHandle {
  const light = theme === "light";
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = light ? 1.08 : 1.2;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();

  // Reflections: RoomEnvironment, dimmed, with one broad softbox for a clean highlight. No external HDR.
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  room.traverse((o) => {
    if (o instanceof Mesh) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m instanceof MeshBasicMaterial || m instanceof MeshStandardMaterial) m.color.multiplyScalar(0.55);
      }
    }
  });
  const softMap = softboxTexture();
  const softbox = new Mesh(new PlaneGeometry(11, 3.4), new MeshBasicMaterial({ color: new Color(7.2, 7.4, 7.1), map: softMap, transparent: true, depthWrite: false, side: DoubleSide }));
  softbox.position.set(5, -1.3, 3.5);
  softbox.lookAt(0, 0, 0);
  room.add(softbox);
  const env = keep(pmrem.fromScene(room, 0.04));
  scene.environment = env.texture;
  room.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) (m as Material).dispose();
    }
  });
  softMap.dispose();
  pmrem.dispose();

  const camera = new PerspectiveCamera(22, 1, 0.1, 80);

  scene.add(new HemisphereLight(0xffffff, light ? 0x737873 : 0x1a1f22, light ? 1.25 : 0.7));
  const key = new DirectionalLight(0xfffdf8, light ? 2.8 : 2.4);
  key.position.set(1, 3, 6);
  scene.add(key);
  const rim = new DirectionalLight(0xc9f4e4, light ? 2.4 : 3.2);
  rim.position.set(4, 1, -2);
  scene.add(rim);
  const rimLeft = new DirectionalLight(MINT, light ? 0.6 : 1.4);
  rimLeft.position.set(-5, 2, -3);
  scene.add(rimLeft);
  // The refusal flare lights the frame rose for a beat. Always present (intensity 0 at rest) so the
  // light count never changes and no shader recompiles mid-animation.
  const flareLight = new PointLight(ROSE, 0, 4.5, 1.6);
  scene.add(flareLight);

  const materials = {
    porcelain: keep(
      new MeshPhysicalMaterial(
        light
          ? { color: 0xfafaf8, metalness: 0.3, roughness: 0.23, clearcoat: 1, clearcoatRoughness: 0.16, envMapIntensity: 0.85 }
          : { color: 0x2b3134, metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.9 },
      ),
    ),
    edge: keep(
      new MeshPhysicalMaterial(
        light
          ? { color: 0xe9eceb, metalness: 0.72, roughness: 0.17, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 1.05 }
          : { color: 0x8d989b, metalness: 0.9, roughness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 1.1 },
      ),
    ),
    chrome: keep(new MeshStandardMaterial({ color: 0xf0f2f1, metalness: 1, roughness: 0.12 })),
    glass: keep(
      new MeshPhysicalMaterial({
        color: light ? 0xc9eadc : 0xa6dcc6,
        metalness: 0,
        roughness: 0.05,
        transmission: 1,
        thickness: 0.3,
        ior: 1.4,
        attenuationColor: MINT.clone(),
        attenuationDistance: light ? 0.7 : 0.5,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        envMapIntensity: 1.2,
        specularIntensity: 1,
      }),
    ),
    yGlass: keep(
      new MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: 0.03,
        transmission: 1,
        thickness: 0.45,
        ior: 1.4,
        attenuationColor: MINT.clone(),
        attenuationDistance: 0.9,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        envMapIntensity: 1.35,
        dispersion: 0.2,
      }),
    ),
    inlay: keep(new MeshStandardMaterial({ color: 0x8ee8c8, emissive: 0x45c597, emissiveIntensity: 1.2, metalness: 0.15, roughness: 0.25 })),
    barrier: keep(
      new MeshPhysicalMaterial({
        color: 0xffe4e9,
        metalness: 0,
        roughness: 0.08,
        transmission: 1,
        thickness: 0.12,
        ior: 1.4,
        attenuationColor: new Color(0xf9a8b8),
        attenuationDistance: 0.6,
        clearcoat: 1,
        emissive: ROSE.clone(),
        emissiveIntensity: 0,
      }),
    ),
  };

  const root = new Group();
  scene.add(root);
  const junction = new Group();
  root.add(junction);

  // Front porcelain face, then glass cassettes stepping back, then a rear frame.
  const OUTER = 2.6;
  const FRONT_Z = 0.62;
  const front = new Mesh(keep(frameGeometry(OUTER, 1.83, 0.12, 0.024)), [materials.porcelain, materials.edge]);
  front.position.z = FRONT_Z;
  front.userData.baseZ = FRONT_Z;
  junction.add(front);

  const glassGeo = keep(frameGeometry(OUTER + 0.01, 1.98, 0.085, 0.014));
  const trimGeo = keep(frameGeometry(OUTER + 0.035, OUTER - 0.07, 0.016, 0.005));
  const inlayGeo = keep(new BoxGeometry(0.035, 0.024, 0.07));
  interface Cassette {
    group: Group;
    inlay: MeshStandardMaterial;
  }
  const cassettes: Cassette[] = [];
  for (let i = 0; i < 5; i += 1) {
    const group = new Group();
    group.position.z = 0.4 - i * 0.2;
    group.userData.baseZ = group.position.z;
    group.add(new Mesh(glassGeo, materials.glass));
    const trim = new Mesh(trimGeo, materials.chrome);
    trim.position.z = 0.038;
    group.add(trim);
    const inlay = keep(materials.inlay.clone());
    for (const side of [-1, 1]) {
      const m = new Mesh(inlayGeo, inlay);
      m.position.set(side * 1.27, -0.32, 0.032);
      group.add(m);
    }
    junction.add(group);
    cassettes.push({ group, inlay });
  }
  const rear = new Mesh(keep(frameGeometry(OUTER, 1.83, 0.075, 0.018)), [materials.porcelain, materials.edge]);
  rear.position.z = -0.62;
  rear.userData.baseZ = rear.position.z;
  junction.add(rear);

  // The glass Y, in logo proportions: arms up-left, up-right and down from a center set a touch high.
  const Y_Z = 0.36;
  const CENTER = new Vector3(0, 0.06, Y_Z);
  const k = 0.072;
  const armDirs = [
    { angle: Math.atan2(7.5, -9.5), length: Math.hypot(9.5, 7.5) * k },
    { angle: Math.atan2(7.5, 9.5), length: Math.hypot(9.5, 7.5) * k },
    { angle: -Math.PI / 2, length: 10 * k },
  ];
  const yGeo = keep(new ExtrudeGeometry(yShape(armDirs, 0.105), { depth: 0.16, bevelEnabled: true, bevelSegments: 8, bevelSize: 0.045, bevelThickness: 0.06, curveSegments: 28 }));
  yGeo.translate(0, 0, -0.08);
  const yMesh = new Mesh(yGeo, materials.yGlass);
  yMesh.position.copy(CENTER);
  junction.add(yMesh);

  // Ports in junction space: where each arm ends, and where its wire enters through the frame side.
  const armEnds = armDirs.map((a) => new Vector3(CENTER.x + Math.cos(a.angle) * a.length, CENTER.y + Math.sin(a.angle) * a.length, Y_Z));
  const sockets = [new Vector3(-OUTER / 2 - 0.03, armEnds[0]!.y, FRONT_Z - 0.02), new Vector3(OUTER / 2 + 0.03, armEnds[1]!.y, FRONT_Z - 0.02), new Vector3(0, -OUTER / 2 - 0.03, FRONT_Z - 0.02)];

  const dimWire = new Color(light ? 0xb9c9c0 : 0x2c353b);
  const hotCurrent = light ? new Color(0x1fa86b).multiplyScalar(1.15) : new Color(0x5ff0c0).multiplyScalar(2.2);
  const channelBase = new Color(light ? 0x7ccfa6 : 0x1f6b52);

  // Internal channels: socket to arm end to core for the inflow ports, core out for the bottom port.
  const channelMats: ShaderMaterial[] = [];
  const channelLengths: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const inflow = i < 2;
    const pts = inflow ? [sockets[i]!.clone(), armEnds[i]!.clone().lerp(sockets[i]!, 0.04), armEnds[i]!.clone(), CENTER.clone()] : [CENTER.clone(), armEnds[i]!.clone(), sockets[i]!.clone()];
    const curve = new CatmullRomCurve3(pts, false, "catmullrom", 0.05);
    const mat = keep(currentMaterial(channelBase, hotCurrent, 0.55));
    mat.uniforms.uLength!.value = curve.getLength();
    channelLengths.push(curve.getLength());
    channelMats.push(mat);
    junction.add(new Mesh(keep(new TubeGeometry(curve, 48, 0.026, 10, false)), mat));
  }

  // Core node and port nodes, like the logo's dots.
  const coreMat = keep(new MeshBasicMaterial({ color: light ? new Color(0x16a36a) : new Color(0x8ff7d0).multiplyScalar(1.6) }));
  const core = new Mesh(keep(new SphereGeometry(0.085, 32, 32)), coreMat);
  core.position.copy(CENTER);
  junction.add(core);
  const nodeGeo = keep(new SphereGeometry(0.045, 24, 24));
  for (const e of armEnds) {
    const n = new Mesh(nodeGeo, materials.chrome);
    n.position.copy(e);
    junction.add(n);
  }
  const grommetGeo = keep(new CylinderGeometry(0.062, 0.062, 0.05, 28));
  sockets.forEach((s, i) => {
    const g = new Mesh(grommetGeo, materials.chrome);
    g.position.copy(s);
    if (i < 2) g.rotation.z = Math.PI / 2;
    junction.add(g);
  });

  // Glows: additive on dark, normal-blended on light (additive vanishes on a white page).
  const glowMap = keep(glowTexture());
  const blending = light ? NormalBlending : AdditiveBlending;
  const glow = (color: Color, opacity: number) => {
    const s = new Sprite(keep(new SpriteMaterial({ map: glowMap, color: color.clone(), transparent: true, opacity, blending, depthWrite: false })));
    return s;
  };
  const coreGlow = glow(light ? new Color(0x5fd39b) : MINT, light ? 0.5 : 0.85);
  coreGlow.position.copy(CENTER);
  coreGlow.position.z += 0.05;
  junction.add(coreGlow);

  // Contact shadow on an invisible floor.
  const FLOOR_Y = -1.72;
  const shadowMap = keep(shadowTexture(!light));
  const shadow = new Mesh(keep(new PlaneGeometry(5.4, 2.6)), keep(new MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = FLOOR_Y;
  root.add(shadow);

  // External wires, in world space, rewritten each frame so they stay plugged into the moving frame.
  // Index 0 is WeakBridge (left, from the attacker card), 1 the chain cards (right), 2 the verdict (down).
  const wireFar = [new Vector3(-5.2, 0.15, -1.4), new Vector3(5.2, 0.15, -1.4), new Vector3(0, FLOOR_Y + 0.03, 3.4)];
  const wireTubes = [0, 1, 2].map(() => new LiveTube(72, 8, 0.02));
  wireTubes.forEach((t) => keep(t.geometry));
  const wireMats = [0, 1, 2].map(() => keep(currentMaterial(dimWire, hotCurrent, 0.9)));
  wireTubes.forEach((t, i) => root.add(new Mesh(t.geometry, wireMats[i]!)));
  const wireCurves = wireFar.map((f) => new CatmullRomCurve3([f.clone(), f.clone(), f.clone(), f.clone()], false, "centripetal"));

  // The barrier: a rose-glass gate on the WeakBridge wire, just outside the frame.
  const BARRIER_U = 0.8;
  const barrier = new Mesh(keep(new CylinderGeometry(0.2, 0.2, 0.035, 48)), materials.barrier);
  const barrierRing = new Mesh(keep(new CylinderGeometry(0.215, 0.215, 0.012, 48, 1, true)), materials.chrome);
  barrier.add(barrierRing);
  root.add(barrier);
  const barrierGlow = glow(ROSE, 0);
  root.add(barrierGlow);
  const forgeGlow = glow(ROSE, 0);
  root.add(forgeGlow);
  const pulseGlows = [0, 1, 2].map(() => {
    const g = glow(light ? new Color(0x3fc58a) : MINT, 0);
    root.add(g);
    return g;
  });

  const pointer = new Vector2(0, 0);
  const tilt = new Vector2(0, 0);
  const clock = new Timer();
  let elapsed = 0;
  let visible = true;
  let raf = 0;
  let first = true;

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const narrow = w / h < 1.05;
    // Keep the frame (and a little air) inside the narrower dimension.
    const dist = Math.max(11, 11 * (1.15 / camera.aspect));
    camera.position.set(0, 0.5, narrow ? dist * 1.04 : dist);
    camera.lookAt(0, -0.3, 0);
    camera.updateProjectionMatrix();
  };
  // A still (reduced motion) frame has to be redrawn when the canvas resizes; the loop redraws itself.
  const ro = new ResizeObserver(() => {
    resize();
    if (reducedMotion && !first) frameAt(INTRO + 2);
  });
  ro.observe(canvas);
  resize();

  const tmp = new Vector3();
  const tan = new Vector3();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const socketWorld = [new Vector3(), new Vector3(), new Vector3()];
  const lead = new Vector3();
  const FLARE_OFFSET = new Vector3(0.4, 0.2, 0.6);

  const layoutWires = () => {
    junction.updateMatrixWorld(true);
    for (let i = 0; i < 3; i += 1) {
      const s = socketWorld[i]!.copy(sockets[i]!).applyMatrix4(junction.matrixWorld);
      // Leave the frame square to its face for a short run, so the wire looks plugged in.
      const out = tmp.copy(sockets[i]!);
      if (i === 0) out.x -= 0.5;
      else if (i === 1) out.x += 0.5;
      else out.y -= 0.22;
      lead.copy(out).applyMatrix4(junction.matrixWorld);
      const far = wireFar[i]!;
      const pts = wireCurves[i]!.points;
      if (i < 2) {
        pts[0]!.copy(far);
        pts[1]!.set(far.x * 0.62 + lead.x * 0.38, lead.y + 0.05, far.z * 0.45 + lead.z * 0.55);
        pts[2]!.copy(lead);
        pts[3]!.copy(s);
      } else {
        // The verdict wire leaves downward, then runs along the floor toward the viewer.
        pts[0]!.copy(s);
        pts[1]!.copy(lead);
        pts[2]!.set(lead.x, FLOOR_Y + 0.03, lead.z + 0.5);
        pts[3]!.copy(far);
      }
      wireTubes[i]!.write(wireCurves[i]!);
      wireMats[i]!.uniforms.uLength!.value = wireCurves[i]!.getLength();
    }
  };

  const frameAt = (tRaw: number) => {
    const t = tRaw / motionScale;
    const live = !reducedMotion;
    const intro = live ? t / INTRO : 1;
    const settle = smooth(intro);
    const grow = live ? easeOutBack(intro) : 1;

    // Pose: turns in from the side and settles into a slow sway that follows the pointer.
    const sway = live ? Math.sin(t * 0.32) * 0.1 + Math.sin(t * 0.13) * 0.05 : 0;
    junction.rotation.y = REST_YAW + (1 - settle) * 0.95 + sway * settle + tilt.x * 0.3;
    junction.rotation.x = REST_PITCH + (1 - settle) * -0.16 + tilt.y * 0.14;
    junction.position.y = (1 - settle) * -0.25 + (live ? Math.sin(t * 0.8) * 0.035 : 0);
    junction.scale.setScalar(0.62 + 0.38 * grow);
    // The stack opens out and closes up as it arrives, like the reference gateway.
    const spread = live ? 0.75 * (1 - smooth((t - 0.3) / 1.9)) : 0;
    for (const part of junction.children) if (typeof part.userData.baseZ === "number") part.position.z = (part.userData.baseZ as number) * (1 + spread);
    shadow.scale.setScalar((0.7 + 0.3 * grow) * (1 - (live ? Math.sin(t * 0.8) * 0.025 : 0)));
    (shadow.material as MeshBasicMaterial).opacity = settle;

    const sinceFirst = t - FORGE_FIRST;
    const cycle = live && sinceFirst >= 0 ? sinceFirst % FORGE_EVERY : -1;
    const traveling = cycle >= 0 && cycle < FORGE_TRAVEL;
    const flashT = cycle >= FORGE_TRAVEL && cycle < FORGE_TRAVEL + FLASH ? (cycle - FORGE_TRAVEL) / FLASH : -1;
    const flash = flashT >= 0 ? (1 - flashT) ** 2 : 0;
    // Current hesitates while the junction refuses the forgery, then picks up.
    const flowT = live ? t - (cycle >= FORGE_TRAVEL ? Math.min(cycle - FORGE_TRAVEL, FLASH) * 0.6 : 0) : 1.4;

    layoutWires();
    for (const [i, m] of wireMats.entries()) {
      m.uniforms.uTime!.value = flowT;
      m.uniforms.uOn!.value = live ? smooth((t - 0.9 - i * 0.2) / 0.8) : 1;
    }
    for (const [i, m] of channelMats.entries()) {
      // Inflow channels run on from their wires; the outflow starts as the core lights.
      m.uniforms.uTime!.value = flowT + (i < 2 ? 0 : 0.3);
      m.uniforms.uOn!.value = live ? smooth((t - 1.3 - i * 0.25) / 0.7) : 1;
      m.uniforms.uTint!.value = flash * (i === 0 ? 1 : 0.65);
    }

    // The forgery rides the WeakBridge wire, stops at the barrier and flares.
    const wm = wireMats[0]!;
    const forgeU = traveling ? smooth(cycle / FORGE_TRAVEL) * BARRIER_U - 0.012 : flash > 0 ? BARRIER_U - 0.012 : -1;
    wm.uniforms.uForgeU!.value = forgeU;
    wm.uniforms.uForgeMix!.value = traveling ? 1 : flash;
    wm.uniforms.uTint!.value = flash * 0.8;

    const wc = wireCurves[0]!;
    wc.getPointAt(BARRIER_U, tmp);
    wc.getTangentAt(BARRIER_U, tan);
    barrier.position.copy(tmp);
    q.setFromUnitVectors(up, tan);
    barrier.quaternion.copy(q);
    barrier.scale.setScalar(1 + flash * 0.18);
    materials.barrier.emissiveIntensity = flash * 2.4 + (traveling ? 0.25 * cycle / FORGE_TRAVEL : 0);
    barrierGlow.position.copy(tmp);
    barrierGlow.scale.setScalar(0.5 + flash * 2.1);
    barrierGlow.material.opacity = flash * (light ? 0.75 : 1);
    flareLight.position.copy(tmp).add(FLARE_OFFSET);
    flareLight.intensity = flash * (light ? 9 : 14);

    if (forgeU >= 0) {
      wc.getPointAt(Math.max(0, forgeU), tmp);
      forgeGlow.position.copy(tmp);
      forgeGlow.scale.setScalar(traveling ? 0.42 : 0.42 + (1 - flash) * 0.6);
      forgeGlow.material.opacity = traveling ? (light ? 0.8 : 0.95) : flash * 0.7;
    } else {
      forgeGlow.material.opacity = 0;
    }

    // A soft glow rides the lead band on each wire, so the current reads as light, not texture.
    for (const [i, g] of pulseGlows.entries()) {
      const len = wireMats[i]!.uniforms.uLength!.value as number;
      const spacing = 0.9;
      const head = ((flowT * 0.9) % spacing) / len;
      const u = (head + ((i * 0.37) % 1) * (spacing / len)) % 1;
      wireCurves[i]!.getPointAt(Math.min(u, 1), tmp);
      g.position.copy(tmp);
      const on = wireMats[i]!.uniforms.uOn!.value as number;
      g.scale.setScalar(0.24);
      g.material.opacity = on * (light ? 0.45 : 0.7) * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.5 * (i === 0 ? 1 - flash : 1);
    }

    // The stack answers: inlays light in a wave from front to back, rose for a beat on refusal.
    const coreOn = live ? smooth((t - 1.4) / 0.6) : 1;
    for (const [i, c] of cassettes.entries()) {
      const phase = ((flowT * 0.8 - i * 0.16) % 1.6 + 1.6) % 1.6;
      const wave = phase < 0.7 ? Math.sin((Math.PI * phase) / 0.7) ** 2 : 0;
      c.inlay.emissive.copy(MINT).lerp(ROSE, flash);
      c.inlay.emissiveIntensity = (0.6 + wave * 3.6) * coreOn + flash * 3;
    }
    coreGlow.material.color.copy(light ? new Color(0x5fd39b) : MINT).lerp(ROSE, flash * 0.7);
    coreGlow.scale.setScalar((0.55 + 0.06 * Math.sin(t * 2.4)) * coreOn + flash * 0.25);
    coreGlow.material.opacity = (light ? 0.5 : 0.85) * coreOn;

    renderer.render(scene, camera);
    if (first) {
      first = false;
      onReady();
    }
  };

  const loop = () => {
    tilt.lerp(pointer, 0.06);
    clock.update();
    elapsed += Math.min(clock.getDelta(), 0.1);
    frameAt(elapsed);
    raf = requestAnimationFrame(loop);
  };

  if (reducedMotion) frameAt(INTRO + 2);
  else raf = requestAnimationFrame(loop);

  return {
    setPointer: (x, y) => pointer.set(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))),
    setVisible: (v) => {
      if (reducedMotion || v === visible) return;
      visible = v;
      if (v) {
        clock.update();
        raf = requestAnimationFrame(loop);
      } else {
        cancelAnimationFrame(raf);
      }
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
