import {forwardRef, useEffect, useImperativeHandle, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import './ShredOverlay.css';

const TUG = 2.4;
const TUG_DECAY = 0.14;
const SLIT_PAD = 6;
const SLIT_HEIGHT = 5;
const FALL_HEIGHT = 150;
const SLIVER = 2;
const DEG = Math.PI / 180;

export interface ShredTexture {
  tex: HTMLCanvasElement;
  scale: number;
}

export interface ShredPrepared {
  rect: DOMRect;
  snap: Promise<ShredTexture>;
  fill: string;
  stripWidth: number;
  feedSpeed: number;
}

export interface ShredOverlayHandle {
  launch: (prepared: ShredPrepared, resolved?: ShredTexture) => void;
}

interface Feed {
  W: number;
  H: number;
  rx: number;
  ry: number;
  lip: number;
  exit: number;
  feedSpeed: number;
  v: number;
  age: number;
  doneAge: number;
  tex: HTMLCanvasElement;
  ts: number;
  consumed: boolean;
  strips: number;
}

interface Strip {
  feed: Feed;
  x: number;
  w: number;
  H: number;
  phase: 'attached' | 'free';
  curl: number;
  amp: number;
  freq: number;
  wave: number;
  rA: number;
  rB: number;
  speed: number;
  splay: number;
  core: number;
  rest: number;
  alpha: number;
  th: number;
  ax: number;
  ay: number;
  vx: number;
  vy: number;
  hang: number;
  pts: number[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ease = (from: number, to: number, dt: number, tau: number) => from + (to - from) * (1 - Math.exp(-dt / tau));
const smooth = (t: number) => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};
const pick = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const side = () => (Math.random() < 0.5 ? -1 : 1);

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const urlCache = new Map<string, Promise<string>>();

const toDataUrl = (src: string): Promise<string> => {
  if (!src || src.startsWith('data:')) return Promise.resolve(src);
  const hit = urlCache.get(src);
  if (hit) return hit;
  const job = fetch(src)
    .then((res) => {
      if (!res.ok) throw new Error('fetch');
      return res.blob();
    })
    .then(
      (blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        }),
    );
  urlCache.set(src, job);
  job.catch(() => urlCache.delete(src));
  return job;
};

export function preloadShredImages(container: HTMLElement | null) {
  if (!container) return;
  container.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    if (src) toDataUrl(src).catch(() => {});
  });
}

const flatTexture = (W: number, H: number, fill: string): ShredTexture => {
  const tex = document.createElement('canvas');
  tex.width = Math.max(1, Math.ceil(W));
  tex.height = Math.max(1, Math.ceil(H));
  const ctx = tex.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, tex.width, tex.height);
  return {tex, scale: 1};
};

const snapshotElement = (node: HTMLElement, W: number, H: number): Promise<ShredTexture> => {
  const clone = node.cloneNode(true) as HTMLElement;
  const src = [node, ...node.querySelectorAll<HTMLElement>('*')];
  const dst = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
  const images: [HTMLImageElement, string][] = [];
  for (let i = 0; i < src.length; i += 1) {
    const from = src[i];
    const to = dst[i];
    if (!to) continue;
    if (from.classList.contains('card-swap-shade') || from.classList.contains('history-project-delete')) {
      to.style.display = 'none';
      continue;
    }
    const cs = getComputedStyle(from);
    const style = to.style;
    for (let j = 0; j < cs.length; j += 1) style.setProperty(cs[j], cs.getPropertyValue(cs[j]));
    if (to instanceof HTMLImageElement && from instanceof HTMLImageElement) {
      images.push([to, from.currentSrc || from.src]);
    }
  }
  Object.assign(clone.style, {
    position: 'relative',
    inset: 'auto',
    margin: '0',
    transform: 'none',
    filter: 'none',
    transition: 'none',
    boxSizing: 'border-box',
    width: `${W}px`,
    height: `${H}px`,
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  const scale = Math.min(3, window.devicePixelRatio || 1);
  return Promise.all(
    images.map(async ([img, from]) => {
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
      try {
        img.setAttribute('src', await toDataUrl(from));
      } catch {
        img.removeAttribute('src');
        img.style.background = 'rgba(127, 127, 127, 0.25)';
      }
    }),
  ).then(
    () =>
      new Promise<ShredTexture>((resolve, reject) => {
        const markup = new XMLSerializer().serializeToString(clone);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="${W}" height="${H}">${markup}</foreignObject></svg>`;
        const img = new Image();
        img.onload = () => {
          const tex = document.createElement('canvas');
          tex.width = Math.max(1, Math.ceil(W * scale));
          tex.height = Math.max(1, Math.ceil(H * scale));
          tex.getContext('2d')!.drawImage(img, 0, 0, tex.width, tex.height);
          resolve({tex, scale});
        };
        img.onerror = () => reject(new Error('snapshot'));
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      }),
  );
};

export function prepareShred(node: HTMLElement): ShredPrepared {
  const rect = node.getBoundingClientRect();
  const W = Math.max(1, rect.width);
  const H = Math.max(1, rect.height);
  const bg = getComputedStyle(node).backgroundColor;
  const fill = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? '#ffffff' : bg;
  let snap: Promise<ShredTexture>;
  try {
    snap = snapshotElement(node, W, H);
  } catch {
    snap = Promise.reject(new Error('snapshot'));
  }
  snap.catch(() => {});
  return {
    rect,
    snap,
    fill,
    stripWidth: W < 220 ? 8 : 10,
    feedSpeed: clamp(H * 0.92, 180, 310),
  };
}

export function resolveShredTexture(prepared: ShredPrepared, timeoutMs = 280): Promise<ShredTexture> {
  const fallback = () => flatTexture(prepared.rect.width, prepared.rect.height, prepared.fill);
  return new Promise<ShredTexture>((resolve) => {
    let settled = false;
    const finish = (value: ShredTexture) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    prepared.snap.then(finish, () => finish(fallback()));
    window.setTimeout(() => finish(fallback()), timeoutMs);
  });
}

const shapeStrip = (st: Strip, len: number, time: number, tear: number) => {
  const pts = st.pts;
  pts.length = 0;
  let x = st.ax;
  let y = st.ay;
  const steps = Math.ceil(len / SLIVER);
  const swing = (3 + 9 * st.rA) * tear;
  const pace = time * (1.6 + st.rA * 2.2) + st.rA * 6.2832;
  for (let j = 0; j <= steps; j += 1) {
    const d = Math.min(j * SLIVER, len);
    const a = st.th + st.curl * d + st.amp * Math.sin(d * st.freq + st.wave);
    const flutter = swing * Math.sin(d * 0.045 + pace);
    pts.push(x + flutter * Math.cos(a), y - flutter * Math.sin(a), a);
    const h = Math.min(SLIVER, len - d);
    x += Math.sin(a) * h;
    y += Math.cos(a) * h;
  }
};

const middleY = (pts: number[]) => {
  if (!pts.length) return 0;
  let y = 0;
  for (let j = 1; j < pts.length; j += 3) y += pts[j];
  return (y * 3) / pts.length;
};

const paintStrip = (ctx: CanvasRenderingContext2D, st: Strip, len: number, dpr: number) => {
  const {tex, ts, exit} = st.feed;
  const pts = st.pts;
  const wc = st.w * st.core;
  const half = wc / 2;
  const sx = (st.x + (st.w - wc) / 2) * ts;
  const v0 = st.H - len;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(0, exit * dpr, ctx.canvas.width, ctx.canvas.height - exit * dpr);
  ctx.clip();
  ctx.globalAlpha = st.alpha;
  for (let j = 0; j + 3 < pts.length; j += 3) {
    const d = (j / 3) * SLIVER;
    const h = Math.min(SLIVER, len - d);
    if (h <= 0) break;
    const ca = Math.cos(pts[j + 2]);
    const sa = Math.sin(pts[j + 2]);
    ctx.setTransform(dpr * ca, -dpr * sa, dpr * sa, dpr * ca, dpr * pts[j], dpr * (exit + pts[j + 1]));
    ctx.drawImage(tex, sx, (v0 + d) * ts, wc * ts, h * ts, -half, 0, wc, h + 0.4);
  }
  ctx.restore();
};

const paintSlit = (ctx: CanvasRenderingContext2D, f: Feed, t: number, dpr: number) => {
  const fadeIn = smooth(f.age / 0.1);
  const fadeOut = f.consumed ? 1 - smooth(f.doneAge / 0.24) : 1;
  const alpha = fadeIn * fadeOut;
  if (alpha <= 0.01) return;
  const jx = f.consumed ? 0 : Math.sin(t * 140) * 0.5;
  const jy = f.consumed ? 0 : Math.cos(t * 97) * 0.35;
  const x = f.rx - SLIT_PAD + jx;
  const y = f.lip + jy;
  const w = f.W + SLIT_PAD * 2;
  const h = SLIT_HEIGHT;
  const r = h / 2;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#2d3b36';
  ctx.shadowColor = 'rgba(20, 42, 36, 0.26)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.fillRect(x + r, y + 0.75, Math.max(0, w - r * 2), 1);
  ctx.restore();
};

const ShredOverlay = forwardRef<ShredOverlayHandle>(function ShredOverlay(_props, ref) {
  const [active, setActive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sim = useRef({
    raf: 0,
    last: 0,
    t: 0,
    dpr: 1,
    feeds: [] as Feed[],
    strips: [] as Strip[],
  });

  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    sim.current.dpr = dpr;
    const w = Math.max(1, Math.ceil(window.innerWidth * dpr));
    const h = Math.max(1, Math.ceil(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  const step = (now: number) => {
    const s = sim.current;
    const canvas = canvasRef.current;
    if (!canvas) {
      s.raf = 0;
      return;
    }
    resizeCanvas();
    const ctx = canvas.getContext('2d')!;
    const dpr = s.dpr;
    const dt = clamp((now - s.last) / 1000, 0, 0.05);
    s.last = now;
    s.t += dt;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Update feeds and draw the remaining upper card feeding into the slit.
    for (let i = s.feeds.length - 1; i >= 0; i -= 1) {
      const f = s.feeds[i];
      f.age += dt;
      if (!f.consumed) {
        f.v = f.feedSpeed * (1 + (TUG - 1) * Math.exp(-f.age / TUG_DECAY));
        f.ry += f.v * dt;
        if (f.ry >= f.lip) {
          f.consumed = true;
          f.doneAge = 0;
        } else {
          const visibleH = clamp(f.lip - f.ry, 0, f.H);
          if (visibleH > 0.5) {
            const jitter = Math.sin(s.t * 150) * 0.5;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.shadowColor = 'rgba(27, 55, 48, 0.18)';
            ctx.shadowBlur = 18;
            ctx.shadowOffsetY = 6;
            ctx.drawImage(
              f.tex,
              0,
              0,
              f.W * f.ts,
              visibleH * f.ts,
              f.rx + jitter,
              f.ry,
              f.W,
              visibleH,
            );
            ctx.restore();
          }
        }
      } else {
        f.ry += f.v * dt;
        f.doneAge += dt;
        if (f.strips === 0 && f.doneAge >= 0.28) {
          s.feeds.splice(i, 1);
          continue;
        }
      }
    }

    // 2. Update and draw curling/fluttering/falling paper strips below the slit.
    for (let i = s.strips.length - 1; i >= 0; i -= 1) {
      const st = s.strips[i];
      const f = st.feed;
      let len = st.H;
      if (st.phase === 'attached') {
        const top = f.ry - f.exit;
        st.hang = top + st.H;
        if (st.hang <= 0) continue;
        st.ax = f.rx + st.x + st.w / 2;
        st.th = Math.sin(s.t * 6 + st.wave) * 0.03 * smooth(st.hang / 40);
        if (top >= 0) {
          st.phase = 'free';
          st.ay = top;
          st.vy = f.v;
          st.vx = pick(-20, 20);
          st.speed = 150 + st.rA * 230;
          st.splay = (st.rA - 0.5) * 320;
          st.rest = side() * pick(0.15, 0.6);
          f.strips -= 1;
        } else {
          st.ay = 0;
          len = st.hang;
        }
      }
      if (st.phase === 'free') {
        const tear = Math.pow(clamp(middleY(st.pts) / FALL_HEIGHT, 0, 1), 1.2);
        const breath = 0.85 + 0.15 * Math.sin(s.t * (1 + st.rB * 2) + st.rA * 6.2832);
        st.vy = ease(st.vy, st.speed * breath, dt, 0.25);
        st.vx = ease(st.vx, st.splay * tear + (st.ax - (f.rx + f.W / 2)) * 0.25, dt, 0.4);
        st.ax += st.vx * dt;
        st.ay += st.vy * dt;
        st.th = ease(st.th, st.rest, dt, 0.5);
        st.core = 1 - smooth(tear / 0.85) * (0.8 - st.rA * 0.16);
        shapeStrip(st, st.H, s.t, tear);
        st.alpha = 1 - smooth((tear - 0.6) / 0.4);
        if (st.alpha <= 0.01 || st.pts[1] > FALL_HEIGHT + 30) {
          s.strips.splice(i, 1);
          continue;
        }
      } else {
        st.core = 1;
        shapeStrip(st, len, s.t, 0);
        st.alpha = 1;
      }
      paintStrip(ctx, st, len, dpr);
    }

    // 3. Paint the vibrating shredder slit above the seam.
    for (const f of s.feeds) {
      paintSlit(ctx, f, s.t, dpr);
    }

    if (s.feeds.length || s.strips.length) {
      s.raf = requestAnimationFrame(step);
    } else {
      s.raf = 0;
      setActive(false);
    }
  };

  const ensureRunning = () => {
    const s = sim.current;
    if (s.raf) return;
    s.last = performance.now();
    s.raf = requestAnimationFrame(step);
  };

  useImperativeHandle(ref, () => ({
    launch(prepared: ShredPrepared, resolved?: ShredTexture) {
      const texture = resolved ?? flatTexture(prepared.rect.width, prepared.rect.height, prepared.fill);
      const W = Math.max(1, prepared.rect.width);
      const H = Math.max(1, prepared.rect.height);
      const lip = Math.max(
        prepared.rect.top + 24,
        Math.min(prepared.rect.bottom, window.innerHeight - FALL_HEIGHT - SLIT_HEIGHT - 12),
      );
      const exit = lip + SLIT_HEIGHT;
      const n = Math.max(6, Math.round(W / Math.max(4, prepared.stripWidth)));
      const sw = Math.floor(W / n);
      const f: Feed = {
        W,
        H,
        rx: prepared.rect.left,
        ry: prepared.rect.top,
        lip,
        exit,
        feedSpeed: prepared.feedSpeed,
        v: prepared.feedSpeed * TUG,
        age: 0,
        doneAge: 0,
        tex: texture.tex,
        ts: texture.scale,
        consumed: false,
        strips: n,
      };
      const s = sim.current;
      s.feeds.push(f);
      for (let i = 0; i < n; i += 1) {
        s.strips.push({
          feed: f,
          x: i * sw,
          w: i === n - 1 ? W - sw * (n - 1) : sw,
          H,
          phase: 'attached',
          curl: side() * pick(0.35, 0.9) * DEG,
          amp: pick(1.5, 4) * DEG,
          freq: (Math.PI * 2) / pick(34, 60),
          wave: pick(0, Math.PI * 2),
          rA: Math.random(),
          rB: Math.random(),
          speed: 0,
          splay: 0,
          core: 1,
          rest: 0,
          alpha: 1,
          th: 0,
          ax: f.rx + i * sw + (i === n - 1 ? W - sw * (n - 1) : sw) / 2,
          ay: 0,
          vx: 0,
          vy: 0,
          hang: 0,
          pts: [],
        });
      }
      setActive(true);
      requestAnimationFrame(() => ensureRunning());
    },
  }));

  useEffect(() => {
    if (active) {
      resizeCanvas();
      ensureRunning();
    }
  }, [active]);

  useEffect(() => {
    const s = sim.current;
    return () => {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
  }, []);

  if (!active || typeof document === 'undefined') return null;

  return createPortal(
    <div className="shred-overlay" aria-hidden="true">
      <canvas ref={canvasRef} className="shred-overlay__canvas" />
    </div>,
    document.body,
  );
});

export default ShredOverlay;
