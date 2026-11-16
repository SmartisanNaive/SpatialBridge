import {useEffect, useRef} from 'react';

const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-=/[]{}<>.';
const CELL_WIDTH = 20;
const CELL_HEIGHT = 23;
const FRAME_MS = 1000 / 24;
const glyph = () => CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
type Cell = {character: string; opacity: number; shade: number};
type Spark = {index: number; born: number; life: number; strength: number};

/** A quiet, monochrome adaptation of the reference's character field and row tears. */
export default function LetterGlitch() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const parent = container?.parentElement;
    const context = canvas?.getContext('2d', {alpha: true});
    const base = document.createElement('canvas');
    const baseContext = base.getContext('2d', {alpha: true});
    if (!container || !canvas || !parent || !context || !baseContext) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = {x: 0, y: 0, inside: false};
    let cells: Cell[] = [];
    let sparks: Spark[] = [];
    let width = 1;
    let height = 1;
    let columns = 1;
    let ratio = 1;
    let frame = 0;
    let lastPaint = 0;
    let started = performance.now();
    let visible = true;
    let disposed = false;
    let resizePending = true;

    const paintCell = (index: number) => {
      const cell = cells[index];
      const x = (index % columns) * CELL_WIDTH;
      const y = Math.floor(index / columns) * CELL_HEIGHT;
      baseContext.clearRect(x, y, CELL_WIDTH, CELL_HEIGHT);
      baseContext.fillStyle = `rgba(${cell.shade},${cell.shade},${cell.shade},${cell.opacity})`;
      baseContext.fillText(cell.character, x + CELL_WIDTH / 2, y + CELL_HEIGHT / 2);
    };

    const resize = () => {
      width = Math.max(1, container.clientWidth);
      height = Math.max(1, container.clientHeight);
      ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = base.width = Math.round(width * ratio);
      canvas.height = base.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      baseContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      for (const target of [context, baseContext]) {
        target.font = '12px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
        target.textAlign = 'center';
        target.textBaseline = 'middle';
      }
      columns = Math.ceil(width / CELL_WIDTH);
      const rows = Math.ceil(height / CELL_HEIGHT);
      cells = Array.from({length: columns * rows}, (_, index) => {
        const x = (index % columns) * CELL_WIDTH;
        const y = Math.floor(index / columns) * CELL_HEIGHT;
        const edge = Math.min(1, x / 70, (width - x) / 70, y / 50, (height - y) / 70);
        // Leave a quieter area behind the main heading and introductory copy.
        const room = clamp(Math.hypot((x - width * .45) / (width * .48), (y - 155) / 180));
        return {character: glyph(), shade: Math.random() < .2 ? 35 : 110,
          opacity: Math.random() < .58 ? (.065 + Math.random() * .065) * edge * (.2 + .8 * room) : 0};
      });
      cells.forEach((_, index) => paintCell(index));
      sparks = [];
      resizePending = false;
    };

    const addSpark = (index: number, now: number, strength = .3, delay = 0) => {
      if (index < 0 || index >= cells.length || sparks.length >= 100) return;
      sparks.push({index, born: now + delay, life: 650 + Math.random() * 700, strength});
    };

    const paint = (now: number) => {
      frame = 0;
      if (disposed || !visible || document.hidden) return;
      if (resizePending) resize();
      const reduced = motion.matches;
      if (reduced || now - lastPaint >= FRAME_MS) {
        const elapsed = lastPaint ? Math.min(100, now - lastPaint) : FRAME_MS;
        lastPaint = now;
        if (!reduced) {
          const changes = Math.max(1, Math.floor(cells.length * elapsed / 1000 * .025));
          for (let n = 0; n < changes; n++) {
            const index = Math.floor(Math.random() * cells.length);
            cells[index].character = glyph();
            paintCell(index);
          }
          if (Math.random() < elapsed * .008) addSpark(Math.floor(Math.random() * cells.length), now, .16);
          if (pointer.inside) {
            const angle = Math.random() * Math.PI * 2;
            const distance = Math.sqrt(Math.random()) * 100;
            const col = Math.floor((pointer.x + Math.cos(angle) * distance) / CELL_WIDTH);
            const row = Math.floor((pointer.y + Math.sin(angle) * distance) / CELL_HEIGHT);
            if (col >= 0 && col < columns && row >= 0) addSpark(row * columns + col, now, .26);
          }
        }
        context.clearRect(0, 0, width, height);
        context.globalAlpha = reduced ? 1 : clamp((now - started) / 1100);
        context.drawImage(base, 0, 0, width, height);
        if (!reduced) {
          sparks = sparks.filter(spark => now - spark.born < spark.life);
          for (const spark of sparks) {
            const age = now - spark.born;
            if (age < 0) continue;
            const attack = clamp(age / 100);
            const fade = (1 - clamp(age / spark.life)) ** 2;
            const x = (spark.index % columns) * CELL_WIDTH + CELL_WIDTH / 2;
            const y = Math.floor(spark.index / columns) * CELL_HEIGHT + CELL_HEIGHT / 2;
            context.fillStyle = `rgba(30,30,30,${spark.strength * attack * fade})`;
            context.fillText(cells[spark.index].character, x, y);
          }
        }
        context.globalAlpha = 1;
      }
      if (!reduced) frame = requestAnimationFrame(paint);
    };

    const wake = () => {
      if (!disposed && !frame && visible && !document.hidden) frame = requestAnimationFrame(paint);
    };
    const locate = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.inside = event.pointerType !== 'touch' && pointer.x >= 0 && pointer.x < width &&
        pointer.y >= 0 && pointer.y < height &&
        !(event.target as Element).closest('.home-grid,.home-header,.home-current');
    };
    const onMove = (event: PointerEvent) => {locate(event);};
    const onLeave = () => {pointer.inside = false;};
    const onClick = (event: PointerEvent) => {
      locate(event);
      if (!pointer.inside || motion.matches || event.button !== 0) return;
      const row = Math.floor(pointer.y / CELL_HEIGHT);
      const col = Math.floor(pointer.x / CELL_WIDTH);
      const now = performance.now();
      for (let step = -12; step <= 12; step++) {
        if (col + step < 0 || col + step >= columns) continue;
        addSpark(row * columns + col + step, now, .32 * (1 - Math.abs(step) / 16), Math.abs(step) * 22);
      }
      wake();
    };
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastPaint = 0;
      wake();
    };
    const onMotion = () => {
      sparks = [];
      started = performance.now() - 1100;
      onVisibility();
    };
    const observer = new ResizeObserver(() => {resizePending = true; wake();});
    observer.observe(container);
    const intersection = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      onVisibility();
    });
    intersection.observe(container);
    parent.addEventListener('pointermove', onMove, {passive: true});
    parent.addEventListener('pointerleave', onLeave);
    parent.addEventListener('pointerdown', onClick, {passive: true});
    document.addEventListener('visibilitychange', onVisibility);
    motion.addEventListener('change', onMotion);
    wake();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      parent.removeEventListener('pointermove', onMove);
      parent.removeEventListener('pointerleave', onLeave);
      parent.removeEventListener('pointerdown', onClick);
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  return <div ref={containerRef} className="home-letter-glitch" aria-hidden="true">
    <canvas ref={canvasRef} />
  </div>;
}
