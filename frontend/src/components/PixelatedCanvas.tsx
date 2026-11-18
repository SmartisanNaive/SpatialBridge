'use client';

import React, {useEffect, useRef, useState} from 'react';
import './PixelatedCanvas.css';

export interface PixelatedCanvasDimensions {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
}

export interface PixelatedCanvasProps {
  src?: string;
  width?: number;
  height?: number;
  /** Size of each sampled cell in CSS pixels */
  cellSize?: number;
  /** Ratio of dot size to cell size (0..1) */
  dotScale?: number;
  shape?: 'circle' | 'square';
  /** Canvas background behind dots; defaults to transparent/light surface */
  backgroundColor?: string;
  grayscale?: boolean;
  className?: string;
  /** Fit within parent container width while preserving full image aspect ratio */
  responsive?: boolean;
  /** Also constrain by parent container height (ideal for full-bleed flex viewports) */
  fillHeight?: boolean;
  /** 'contain' always shows the complete uncropped image; 'cover' fills & crops */
  objectFit?: 'contain' | 'cover';
  /** Maximum canvas width in CSS pixels when responsive */
  maxWidth?: number;
  /** Maximum canvas height in CSS pixels when auto-fitting aspect ratio */
  maxHeight?: number;
  /** Fraction of low-contrast cells dropped for airy texture (0..1) */
  dropoutStrength?: number;
  interactive?: boolean;
  distortionStrength?: number;
  distortionRadius?: number;
  distortionMode?: 'repel' | 'attract' | 'swirl';
  followSpeed?: number;
  sampleAverage?: boolean;
  tintColor?: string;
  tintStrength?: number;
  maxFps?: number;
  fadeOnLeave?: boolean;
  fadeSpeed?: number;
  jitterStrength?: number;
  jitterSpeed?: number;
  ariaLabel?: string;
  onDimensionsChange?: (dims: PixelatedCanvasDimensions) => void;
}

interface DotSample {
  x: number;
  y: number;
  color: string;
  seed: number;
  drop: boolean;
}

function hash2D(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function parseHexColor(hex?: string): [number, number, number] | null {
  if (!hex) return null;
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  return null;
}

export const PixelatedCanvas: React.FC<PixelatedCanvasProps> = ({
  src,
  width = 480,
  height = 360,
  cellSize = 4,
  dotScale = 0.9,
  shape = 'square',
  backgroundColor = 'transparent',
  grayscale = false,
  className = '',
  responsive = true,
  fillHeight = false,
  objectFit = 'contain',
  maxWidth,
  maxHeight = 520,
  dropoutStrength = 0.1,
  interactive = true,
  distortionStrength = 0.1,
  distortionRadius = 200,
  distortionMode = 'repel',
  followSpeed = 0.2,
  sampleAverage = true,
  tintColor,
  tintStrength = 0.2,
  maxFps = 60,
  fadeOnLeave = true,
  fadeSpeed = 0.12,
  jitterStrength = 4,
  jitterSpeed = 1,
  ariaLabel = 'Interactive pixelated image preview',
  onDimensionsChange,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDimsRef = useRef(onDimensionsChange);
  onDimsRef.current = onDimensionsChange;

  const [containerSize, setContainerSize] = useState<{w: number; h: number}>({w: 0, h: 0});
  const [ready, setReady] = useState(false);
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<{w: number; h: number}>({w: width, h: height});

  const samplesRef = useRef<DotSample[]>([]);
  const dimsRef = useRef<{w: number; h: number; dpr: number}>({w: width, h: height, dpr: 1});
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const reduceMotionRef = useRef<boolean>(false);

  const pointerRef = useRef<{
    targetX: number;
    targetY: number;
    animX: number;
    animY: number;
    active: boolean;
    activity: number;
    initialized: boolean;
  }>({
    targetX: -9999,
    targetY: -9999,
    animX: -9999,
    animY: -9999,
    active: false,
    activity: 0,
    initialized: false,
  });

  const configRef = useRef({
    cellSize,
    dotScale,
    shape,
    backgroundColor,
    interactive,
    distortionStrength,
    distortionRadius,
    distortionMode,
    followSpeed,
    maxFps,
    fadeOnLeave,
    fadeSpeed,
    jitterStrength,
    jitterSpeed,
  });
  configRef.current = {
    cellSize,
    dotScale,
    shape,
    backgroundColor,
    interactive,
    distortionStrength,
    distortionRadius,
    distortionMode,
    followSpeed,
    maxFps,
    fadeOnLeave,
    fadeSpeed,
    jitterStrength,
    jitterSpeed,
  };

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      reduceMotionRef.current = mq.matches;
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!responsive || !hostRef.current) return;
    const node = hostRef.current;
    const update = () => {
      const nextW = Math.floor(node.clientWidth);
      const nextH = fillHeight ? Math.floor(node.clientHeight) : 0;
      if (nextW > 0) {
        setContainerSize((prev) =>
          Math.abs(prev.w - nextW) > 1 || (fillHeight && Math.abs(prev.h - nextH) > 1)
            ? {w: nextW, h: nextH}
            : prev,
        );
      }
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [responsive, fillHeight]);

  const drawFrame = (now: number, forceStatic = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    const cfg = configRef.current;
    const {w, h, dpr} = dimsRef.current;
    const samples = samplesRef.current;
    const ptr = pointerRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cfg.backgroundColor && cfg.backgroundColor !== 'transparent') {
      ctx.fillStyle = cfg.backgroundColor;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    const usePhysics = cfg.interactive && !reduceMotionRef.current && !forceStatic;
    if (usePhysics) {
      if (ptr.active) {
        if (!ptr.initialized) {
          ptr.animX = ptr.targetX;
          ptr.animY = ptr.targetY;
          ptr.initialized = true;
        } else {
          ptr.animX += (ptr.targetX - ptr.animX) * cfg.followSpeed;
          ptr.animY += (ptr.targetY - ptr.animY) * cfg.followSpeed;
        }
        ptr.activity += (1 - ptr.activity) * Math.min(1, cfg.fadeSpeed * 2.2);
      } else if (cfg.fadeOnLeave) {
        ptr.activity *= Math.max(0, 1 - cfg.fadeSpeed);
        if (ptr.activity < 0.002) {
          ptr.activity = 0;
          ptr.initialized = false;
        }
      }
    } else if (forceStatic) {
      ptr.activity = 0;
    }

    const dotSize = Math.max(1, cfg.cellSize * cfg.dotScale);
    const half = dotSize / 2;
    const radius = Math.max(1, cfg.distortionRadius);
    const radiusSq = radius * radius;
    const act = usePhysics ? ptr.activity : 0;
    const pushScale = cfg.distortionStrength * radius * 1.15;
    const timeSec = now * 0.001;
    const isCircle = cfg.shape === 'circle';
    const px0 = ptr.animX;
    const py0 = ptr.animY;

    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      if (s.drop) continue;

      let x = s.x;
      let y = s.y;

      if (act > 0.002) {
        const dx = x - px0;
        const dy = y - py0;
        const distSq = dx * dx + dy * dy;
        if (distSq < radiusSq) {
          const dist = Math.sqrt(distSq);
          const falloff = 1 - dist / radius;
          const influence = falloff * falloff * act;

          if (pushScale > 0) {
            const invDist = 1 / (dist + 0.001);
            const nx = dx * invDist;
            const ny = dy * invDist;
            const disp = influence * pushScale;
            if (cfg.distortionMode === 'attract') {
              x -= nx * disp;
              y -= ny * disp;
            } else if (cfg.distortionMode === 'swirl') {
              x += -ny * disp;
              y += nx * disp;
            } else {
              x += nx * disp;
              y += ny * disp;
            }
          }

          if (cfg.jitterStrength > 0) {
            const phase = timeSec * cfg.jitterSpeed * 2.4 + s.seed * 6.2831853;
            x += Math.sin(phase) * cfg.jitterStrength * influence;
            y += Math.cos(phase * 0.87 + s.seed * 3.14159) * cfg.jitterStrength * influence;
          }
        }
      }

      ctx.fillStyle = s.color;
      if (isCircle) {
        ctx.beginPath();
        ctx.arc(x, y, half, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(x - half, y - half, dotSize, dotSize);
      }
    }

    return usePhysics && (ptr.active || ptr.activity > 0.002);
  };

  const stopLoop = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  };

  const wakeLoop = () => {
    if (rafRef.current) return;
    const step = (now: number) => {
      const minInterval = 1000 / Math.max(1, configRef.current.maxFps);
      if (now - lastFrameRef.current >= minInterval - 1) {
        lastFrameRef.current = now;
        const keepGoing = drawFrame(now, false);
        if (!keepGoing) {
          rafRef.current = 0;
          return;
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    stopLoop();
    setFallbackSrc(null);

    if (!src) {
      samplesRef.current = [];
      setReady(false);
      return;
    }

    let cancelled = false;
    const img = new Image();
    if (/^https?:\/\//i.test(src)) {
      img.crossOrigin = 'anonymous';
    }

    const sampleImage = () => {
      if (cancelled || !img.naturalWidth || !img.naturalHeight) return;

      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const measuredW = hostRef.current ? Math.floor(hostRef.current.clientWidth) : 0;
      const measuredH = fillHeight && hostRef.current ? Math.floor(hostRef.current.clientHeight) : 0;
      const rawAvailW = responsive ? measuredW || containerSize.w || width : width;
      const availW = maxWidth ? Math.min(rawAvailW, maxWidth) : rawAvailW;
      const rawAvailH = responsive
        ? fillHeight && (measuredH || containerSize.h) > 48
          ? Math.min(measuredH || containerSize.h, maxHeight)
          : maxHeight
        : height;
      const boundH = Math.max(48, rawAvailH);

      let displayW = Math.max(1, Math.round(availW));
      let displayH = Math.max(1, Math.round(boundH));

      if (objectFit === 'contain') {
        const scale = Math.min(availW / iw, boundH / ih);
        displayW = Math.max(1, Math.round(iw * scale));
        displayH = Math.max(1, Math.round(ih * scale));
      } else {
        displayW = Math.max(1, Math.round(availW));
        displayH = Math.max(1, Math.round(responsive ? Math.min(boundH, (availW * height) / Math.max(1, width)) : height));
      }

      const off = document.createElement('canvas');
      off.width = displayW;
      off.height = displayH;
      const offCtx = off.getContext('2d', {willReadFrequently: true});
      if (!offCtx) return;

      offCtx.imageSmoothingEnabled = true;
      offCtx.imageSmoothingQuality = 'high';

      if (objectFit === 'cover') {
        const scale = Math.max(displayW / iw, displayH / ih);
        const sw = displayW / scale;
        const sh = displayH / scale;
        const sx = (iw - sw) / 2;
        const sy = (ih - sh) / 2;
        offCtx.drawImage(img, sx, sy, sw, sh, 0, 0, displayW, displayH);
      } else {
        offCtx.drawImage(img, 0, 0, iw, ih, 0, 0, displayW, displayH);
      }

      let data: Uint8ClampedArray;
      try {
        data = offCtx.getImageData(0, 0, displayW, displayH).data;
      } catch {
        setFallbackSrc(src);
        setReady(true);
        return;
      }

      const step = Math.max(2, Math.round(cellSize));
      const cols = Math.max(1, Math.floor(displayW / step));
      const rows = Math.max(1, Math.floor(displayH / step));
      const padX = (displayW - cols * step) / 2;
      const padY = (displayH - rows * step) / 2;
      const tintRgb = parseHexColor(tintColor);
      const tMix = tintRgb ? Math.min(1, Math.max(0, tintStrength)) : 0;

      const rawLum = new Float32Array(cols * rows);
      const cellR = new Uint8Array(cols * rows);
      const cellG = new Uint8Array(cols * rows);
      const cellB = new Uint8Array(cols * rows);
      const cellA = new Float32Array(cols * rows);

      for (let row = 0; row < rows; row += 1) {
        const yStart = Math.floor(padY + row * step);
        const yEnd = Math.min(displayH, yStart + step);
        for (let col = 0; col < cols; col += 1) {
          const xStart = Math.floor(padX + col * step);
          const xEnd = Math.min(displayW, xStart + step);
          const idx = row * cols + col;

          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;

          if (sampleAverage) {
            let count = 0;
            for (let py = yStart; py < yEnd; py += 1) {
              let pOffset = (py * displayW + xStart) * 4;
              for (let px = xStart; px < xEnd; px += 1) {
                r += data[pOffset];
                g += data[pOffset + 1];
                b += data[pOffset + 2];
                a += data[pOffset + 3];
                count += 1;
                pOffset += 4;
              }
            }
            if (count > 0) {
              r /= count;
              g /= count;
              b /= count;
              a /= count * 255;
            }
          } else {
            const cx = Math.min(displayW - 1, Math.floor((xStart + xEnd) / 2));
            const cy = Math.min(displayH - 1, Math.floor((yStart + yEnd) / 2));
            const pOffset = (cy * displayW + cx) * 4;
            r = data[pOffset];
            g = data[pOffset + 1];
            b = data[pOffset + 2];
            a = data[pOffset + 3] / 255;
          }

          if (grayscale) {
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            r = l;
            g = l;
            b = l;
          }

          if (tintRgb && tMix > 0) {
            r = r * (1 - tMix) + tintRgb[0] * tMix;
            g = g * (1 - tMix) + tintRgb[1] * tMix;
            b = b * (1 - tMix) + tintRgb[2] * tMix;
          }

          cellR[idx] = Math.round(r);
          cellG[idx] = Math.round(g);
          cellB[idx] = Math.round(b);
          cellA[idx] = a;
          rawLum[idx] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        }
      }

      const samples: DotSample[] = [];
      const dropStr = Math.min(1, Math.max(0, dropoutStrength));

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const idx = row * cols + col;
          const a = cellA[idx];
          if (a < 0.04) continue;

          // Estimate local contrast so structural tissue features stay crisp while uniform areas breathe
          let maxDiff = 0;
          if (dropStr > 0) {
            const lum = rawLum[idx];
            if (col > 0) maxDiff = Math.max(maxDiff, Math.abs(lum - rawLum[idx - 1]));
            if (col + 1 < cols) maxDiff = Math.max(maxDiff, Math.abs(lum - rawLum[idx + 1]));
            if (row > 0) maxDiff = Math.max(maxDiff, Math.abs(lum - rawLum[idx - cols]));
            if (row + 1 < rows) maxDiff = Math.max(maxDiff, Math.abs(lum - rawLum[idx + cols]));
          }

          const seed = hash2D(col, row);
          const contrastGuard = Math.min(1, maxDiff * 5.5);
          const effectiveDrop = dropStr * (1 - contrastGuard * 0.78);
          const drop = dropStr > 0 && seed < effectiveDrop;

          samples.push({
            x: padX + (col + 0.5) * step,
            y: padY + (row + 0.5) * step,
            color:
              a >= 0.995
                ? `rgb(${cellR[idx]},${cellG[idx]},${cellB[idx]})`
                : `rgba(${cellR[idx]},${cellG[idx]},${cellB[idx]},${a.toFixed(2)})`,
            seed,
            drop,
          });
        }
      }

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      samplesRef.current = samples;
      dimsRef.current = {w: displayW, h: displayH, dpr};
      setCanvasSize({w: displayW, h: displayH});

      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = Math.max(1, Math.round(displayW * dpr));
        canvas.height = Math.max(1, Math.round(displayH * dpr));
        drawFrame(performance.now(), true);
      }

      setReady(true);
      onDimsRef.current?.({
        naturalWidth: iw,
        naturalHeight: ih,
        displayWidth: displayW,
        displayHeight: displayH,
      });
    };

    img.onload = () => {
      if ('decode' in img) {
        img.decode().then(sampleImage, sampleImage);
      } else {
        sampleImage();
      }
    };
    img.src = src;

    return () => {
      cancelled = true;
      img.onload = null;
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    src,
    width,
    height,
    maxWidth,
    maxHeight,
    containerSize.w,
    containerSize.h,
    responsive,
    fillHeight,
    objectFit,
    cellSize,
    grayscale,
    dropoutStrength,
    sampleAverage,
    tintColor,
    tintStrength,
    backgroundColor,
    dotScale,
    shape,
  ]);

  useEffect(() => {
    return () => stopLoop();
  }, []);

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive || reduceMotionRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ptr = pointerRef.current;
    ptr.targetX = e.clientX - rect.left;
    ptr.targetY = e.clientY - rect.top;
    ptr.active = true;
    wakeLoop();
  };

  const handlePointerLeave = () => {
    if (!interactive) return;
    pointerRef.current.active = false;
    if (fadeOnLeave && pointerRef.current.activity > 0.002) {
      wakeLoop();
    }
  };

  return (
    <div ref={hostRef} className={`pixelated-canvas-host${fillHeight ? ' is-fill-height' : ''}`}>
      {fallbackSrc ? (
        <img
          src={fallbackSrc}
          alt={ariaLabel}
          className={`pixelated-canvas-fallback${className ? ` ${className}` : ''}`}
          style={{maxHeight: responsive ? `${maxHeight}px` : `${height}px`}}
        />
      ) : (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={ariaLabel}
          onPointerEnter={handlePointerMove}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          className={`pixelated-canvas-el${ready ? ' is-ready' : ''}${interactive ? ' is-interactive' : ''}${className ? ` ${className}` : ''}`}
          style={{
            width: `${canvasSize.w}px`,
            height: `${canvasSize.h}px`,
            maxWidth: '100%',
          }}
        />
      )}
    </div>
  );
};

export default PixelatedCanvas;
