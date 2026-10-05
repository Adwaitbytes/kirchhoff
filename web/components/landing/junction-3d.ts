/**
 * The Kirchhoff junction in glass: layered translucent plates and rings where three currents meet.
 * Vanilla three.js, loaded lazily by the landing only. Teal current flows in on three wires and out;
 * every ~10s a forged red pulse arrives on the WeakBridge wire, the plates flash rose and the pulse is
 * refused at the junction. Reduced motion renders one settled frame and never animates.
 */
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  NormalBlending,
  CatmullRomCurve3,
  Timer,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
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
const TEAL = new Color("#2dd4bf");
const ROSE = new Color("#f43f5e");
const FORGE_EVERY = 10;
const FORGE_TRAVEL = 1.6;
const FLASH = 1.8;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

export function mountJunction({ canvas, theme, reducedMotion, motionScale, onReady }: JunctionOptions): JunctionHandle {
  const light = theme === "light";
  // On a light page additive glow vanishes into white; use the deep brand green and normal blending.
  const ACCENT = light ? new Color("#118453") : TEAL;
  const BLEND = light ? NormalBlending : AdditiveBlending;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = theme === "light" ? 0.92 : 1.2;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;

  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 2.6, 6.4);
  camera.lookAt(0, 0, 0);

  scene.add(new HemisphereLight(0xffffff, theme === "light" ? 0xe8efe9 : 0x0b0d10, theme === "light" ? 1.1 : 0.6));
  const key = new DirectionalLight(0xffffff, theme === "light" ? 2.2 : 2.6);
  key.position.set(3, 6, 4);
  scene.add(key);
  const rim = new DirectionalLight(MINT, 1.4);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const junction = new Group();
  scene.add(junction);

  // Glass plates: the junction body. Thin discs that separate during the intro.
  const plateMats: MeshPhysicalMaterial[] = [];
  const rimRings: Mesh[] = [];
  const plates: Mesh[] = [];
  const plateSpec = [
    { r: 1.3, y: -0.48 },
    { r: 1.08, y: -0.16 },
    { r: 0.86, y: 0.16 },
    { r: 0.62, y: 0.48 },
  ];
  for (const [i, p] of plateSpec.entries()) {
    const mat = new MeshPhysicalMaterial({
      color: light ? new Color("#9fe3c2") : new Color().copy(MINT).lerp(new Color(0xffffff), 0.25),
      transmission: theme === "light" ? 0.55 : 0.8,
      thickness: 0.9,
      roughness: 0.08,
      iridescence: 0.35,
      iridescenceIOR: 1.3,
      sheen: 0.4,
      sheenColor: new Color().copy(MINT),
      ior: 1.42,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      attenuationColor: light ? new Color("#118453") : new Color().copy(MINT),
      attenuationDistance: light ? 1.2 : 2.4,
      emissive: new Color(0x000000),
      transparent: true,
      opacity: 0.94,
    });
    const mesh = new Mesh(new CylinderGeometry(p.r, p.r, 0.1, 96, 1), mat);
    // A lit rim on every plate: the glass edge catching current.
    const rimRing = new Mesh(
      new TorusGeometry(p.r, 0.012, 8, 160),
      new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: light ? 0.75 : 0.9, blending: BLEND, depthWrite: false }),
    );
    rimRing.rotation.x = Math.PI / 2;
    rimRing.position.y = 0.05;
    mesh.add(rimRing);
    rimRings.push(rimRing);
    mesh.position.y = p.y;
    mesh.userData.restY = p.y;
    mesh.userData.index = i;
    junction.add(mesh);
    plates.push(mesh);
    plateMats.push(mat);
  }

  // Current rings and the core.
  const ringMat = new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85, blending: BLEND, depthWrite: false });
  const ringA = new Mesh(new TorusGeometry(1.6, 0.014, 12, 180), ringMat);
  ringA.rotation.x = Math.PI / 2;
  ringA.position.y = -0.48;
  junction.add(ringA);
  const ringB = new Mesh(new TorusGeometry(0.98, 0.01, 12, 140), ringMat.clone());
  ringB.rotation.x = Math.PI / 2;
  ringB.position.y = 0.12;
  junction.add(ringB);
  const coreMat = new MeshBasicMaterial({ color: new Color(0xffffff), transparent: true, opacity: 0.95 });
  const core = new Mesh(new SphereGeometry(0.11, 32, 32), coreMat);
  core.position.y = 0.62;
  junction.add(core);
  const haloMat = new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.25, blending: BLEND, depthWrite: false });
  const halo = new Mesh(new SphereGeometry(0.32, 32, 32), haloMat);
  halo.position.copy(core.position);
  junction.add(halo);

  // Three wires: two remotes behind, the home chain in front. Index 0 carries WeakBridge.
  const anchors = [new Vector3(-4.8, -0.48, -0.9), new Vector3(4.8, -0.48, -0.9), new Vector3(0, -0.48, 2.7)];
  const wireColor = new Color(theme === "light" ? 0x8fa69a : 0x3a4350);
  const curves = anchors.map((a) => {
    const mid = new Vector3(a.x * 0.55, -0.48, a.z * 0.55 + (a.z < 0 ? 0.5 : -0.2));
    return new CatmullRomCurve3([a, mid, new Vector3(a.x * 0.27, -0.48, a.z * 0.27)]);
  });
  const wireMats: MeshBasicMaterial[] = [];
  for (const c of curves) {
    const mat = new MeshBasicMaterial({ color: wireColor, transparent: true, opacity: 0.9 });
    wireMats.push(mat);
    scene.add(new Mesh(new TubeGeometry(c, 64, 0.018, 8, false), mat));
  }

  // Pulses: three teal per wire (flowing in, one flowing out), one rose forged pulse.
  const pulseGeo = new SphereGeometry(0.05, 16, 16);
  const glowGeo = new SphereGeometry(0.13, 16, 16);
  interface Pulse {
    mesh: Mesh;
    glow: Mesh;
    wire: number;
    offset: number;
    out: boolean;
  }
  const pulses: Pulse[] = [];
  const makePulse = (color: Color, wire: number, offset: number, out: boolean): Pulse => {
    const mesh = new Mesh(pulseGeo, new MeshBasicMaterial({ color: new Color(0xffffff) }));
    const glow = new Mesh(glowGeo, new MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: BLEND, depthWrite: false }));
    scene.add(mesh, glow);
    return { mesh, glow, wire, offset, out };
  };
  for (let w = 0; w < 3; w += 1) {
    pulses.push(makePulse(ACCENT, w, w * 0.27, false));
    pulses.push(makePulse(ACCENT, w, w * 0.27 + 0.5, w === 2));
  }
  const forged = makePulse(ROSE, 0, 0, false);
  (forged.mesh.material as MeshBasicMaterial).color.copy(new Color("#ffe4e8"));

  const pointer = new Vector2(0, 0);
  const tilt = new Vector2(0, 0);
  const clock = new Timer();
  let visible = true;
  let elapsed = 0;
  let raf = 0;
  let first = true;

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the junction framed on narrow screens.
    camera.position.set(0, 2.6, w / h < 1 ? 8.8 : 6.4);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const tmp = new Vector3();
  const frame = (tRaw: number) => {
    const t = tRaw / motionScale;
    // Intro: plates rise apart from a stacked slab, the assembly turns into place.
    const intro = reducedMotion ? 1 : easeOutCubic(clamp01(t / 1.8));
    junction.scale.setScalar(0.72 + 0.28 * intro);
    for (const p of plates) {
      const i = p.userData.index as number;
      const k = easeOutCubic(clamp01((t - i * 0.12) / 1.4));
      p.position.y = (p.userData.restY as number) * (reducedMotion ? 1 : k);
    }
    const idle = reducedMotion ? 0 : t * 0.16;
    junction.rotation.y = -0.6 * (1 - intro) + idle + tilt.x * 0.25;
    junction.rotation.x = tilt.y * 0.12;
    junction.position.y = reducedMotion ? 0 : Math.sin(t * 0.9) * 0.04;

    // Forge cycle: travel in on wire 0, flash at the junction, refuse.
    const cycle = reducedMotion ? 99 : (t - 6) % FORGE_EVERY;
    const traveling = t > 6 && cycle >= 0 && cycle < FORGE_TRAVEL;
    const flash = t > 6 && cycle >= FORGE_TRAVEL && cycle < FORGE_TRAVEL + FLASH ? 1 - (cycle - FORGE_TRAVEL) / FLASH : 0;

    for (const pl of plateMats) {
      pl.emissive.copy(ROSE).multiplyScalar(flash * (light ? 0.35 : 0.55));
      pl.attenuationColor.copy(light ? new Color("#118453") : MINT).lerp(ROSE, flash * 0.8);
    }
    // Hue interpolation between green and rose passes through mud or magenta; switch instead.
    const ringColor = flash > 0.04 ? ROSE : ACCENT;
    (ringA.material as MeshBasicMaterial).color.copy(ringColor);
    (ringB.material as MeshBasicMaterial).color.copy(ringColor);
    for (const r of rimRings) (r.material as MeshBasicMaterial).color.copy(ringColor);
    haloMat.color.copy(flash > 0.04 ? ROSE : light ? MINT : TEAL);
    haloMat.opacity = (light ? 0.35 : 0.22) + 0.12 * Math.sin(t * 2.2) + flash * (light ? 0.1 : 0.3);
    halo.scale.setScalar(1 + flash * 0.7);
    wireMats[0]?.color.copy(wireColor).lerp(ROSE, Math.max(flash, traveling ? 0.6 : 0));

    // Teal current slows to a crawl while the junction refuses the forgery.
    const speed = flash > 0 ? 0.08 : 0.32;
    for (const p of pulses) {
      const curve = curves[p.wire];
      if (!curve) continue;
      const u = (((t * speed + p.offset) % 1) + 1) % 1;
      curve.getPointAt(p.out ? 1 - u : u, tmp);
      p.mesh.position.copy(tmp);
      p.glow.position.copy(tmp);
      const vis = reducedMotion ? 0 : Math.sin(u * Math.PI);
      p.mesh.scale.setScalar(vis);
      p.glow.scale.setScalar(vis);
    }
    const fc = curves[0];
    if (fc) {
      const u = traveling ? cycle / FORGE_TRAVEL : flash > 0 ? 1 : 0;
      fc.getPointAt(Math.min(u, 0.999), tmp);
      forged.mesh.position.copy(tmp);
      forged.glow.position.copy(tmp);
      const s = traveling ? 1.3 : flash > 0 ? 1 + (1 - flash) * 3 : 0;
      forged.mesh.scale.setScalar(traveling ? 1.3 : 0);
      forged.glow.scale.setScalar(s);
      (forged.glow.material as MeshBasicMaterial).opacity = traveling ? 0.8 : flash * 0.6;
    }

    renderer.render(scene, camera);
    if (first) {
      first = false;
      onReady();
    }
  };

  const loop = () => {
    tilt.lerp(pointer, 0.05);
    clock.update();
    elapsed += Math.min(clock.getDelta(), 0.1);
    frame(elapsed);
    raf = requestAnimationFrame(loop);
  };

  if (reducedMotion) {
    frame(4);
  } else {
    raf = requestAnimationFrame(loop);
  }

  return {
    setPointer: (x, y) => pointer.set(x, y),
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
      scene.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          const m = o.material;
          (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
        }
      });
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
