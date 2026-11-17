import { useEffect, useRef, useState } from 'react';

import './GradientASCII.css';

const CHARACTERS = ' =+xX0S8#@';
const CELL_WIDTH = 48;
const CELL_HEIGHT = 80;

const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Sample the flowing field at cell centers so every character keeps one tone.
// The gradient and glyph atlas share one pass; no full-screen blur targets are needed.
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uRatio;
uniform float uTime;
uniform float uIntro;
uniform float uMotion;
uniform vec3 uPointer;
uniform vec3 uClick;
uniform sampler2D uAtlas;
in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
    mix(hash(i + vec2(0, 1)), hash(i + vec2(1)), u.x), u.y);
}
float field(vec2 p) {
  float span = max(uResolution.x / uResolution.y, 1.0);
  float x = p.x / span;
  float warp = (noise(p * 2.8 + vec2(uTime * 0.12, -uTime * 0.09)) - 0.5) * 0.16;
  float arch = -0.18 - 0.38 * x * x + 0.025 * sin(uTime * 0.6);
  float edge = p.y - arch + warp;
  float rim = exp(-pow(edge / 0.17, 2.0));
  float sky = smoothstep(-0.05, 0.42, edge) * 0.22;
  return clamp(rim * 0.85 + sky, 0.0, 1.0);
}
void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 cellSize = vec2(10.8, 18.0) * uRatio;
  vec2 coord = gl_FragCoord.xy / cellSize;
  vec2 cell = floor(coord);
  vec2 local = fract(coord);
  vec2 p = ((cell + 0.5) * cellSize / uResolution - 0.5) * vec2(aspect, 1.0);
  float value = field(p);
  float level = hash(cell * 1.73 + 4.1);
  float tick = floor(uTime * 9.0 + level * 9.0);
  float flicker = (hash(cell + tick * 17.7) - 0.5) * 0.08 * uMotion;
  float tone = clamp(value + flicker, 0.0, 1.0);
  float index = floor(tone * 9.0 + 0.5);
  float pointer = exp(-dot(p - uPointer.xy, p - uPointer.xy) / 0.012) * uPointer.z;
  float age = uTime - uClick.z;
  float wave = exp(-pow((length(p - uClick.xy) - age * 0.5) / 0.035, 2.0))
    * step(0.0, age) * (1.0 - smoothstep(0.0, 1.2, age));
  float scramble = max(pointer, wave) * uMotion;
  if (hash(cell + tick) < scramble) index = 1.0 + floor(hash(cell + tick * 1.37) * 9.0);
  vec2 atlasUv = vec2((index + local.x) / 10.0, 1.0 - local.y);
  float glyph = texture(uAtlas, atlasUv).a;
  float present = step(hash(cell + 8.0), 0.8);
  float reveal = smoothstep(0.0, 1.0, clamp(uIntro * 1.5 - abs(p.y) * 0.6, 0.0, 1.0));
  float alpha = glyph * present * smoothstep(0.03, 0.18, value)
    * (0.35 + 0.55 * level) * reveal;
  vec3 ink = mix(vec3(0.12, 0.25, 0.68), vec3(0.08, 0.56, 0.76), tone);
  vec3 background = mix(vec3(0.957, 0.965, 0.973), vec3(0.82, 0.91, 0.98), field((vUv - 0.5) * vec2(aspect, 1.0)) * 0.45);
  outColor = vec4(mix(background, ink, alpha * 0.75), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function GradientASCII() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) return;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      if (program) gl.deleteProgram(program);
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }

    const atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = CELL_WIDTH * CHARACTERS.length;
    atlasCanvas.height = CELL_HEIGHT;
    const context = atlasCanvas.getContext('2d');
    const texture = gl.createTexture();
    const vao = gl.createVertexArray();
    if (!context || !texture || !vao) {
      gl.deleteProgram(program);
      if (texture) gl.deleteTexture(texture);
      if (vao) gl.deleteVertexArray(vao);
      return;
    }
    context.font = '300 62px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#fff';
    [...CHARACTERS].forEach((character, index) => {
      context.fillText(character, (index + 0.5) * CELL_WIDTH, CELL_HEIGHT / 2 + 2);
    });
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const uniforms = Object.fromEntries(
      ['uResolution', 'uRatio', 'uTime', 'uIntro', 'uMotion', 'uPointer', 'uClick', 'uAtlas']
        .map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let time = 0;
    let last = 0;
    let ratio = 1;
    let visible = true;
    let lost = false;
    let disposed = false;
    let pointerX = 0;
    let pointerY = 0;
    let pointerStrength = 0;
    let clickX = 0;
    let clickY = 0;
    let clickTime = -10;

    const draw = () => {
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uniforms.uAtlas, 0);
      gl.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uRatio, ratio);
      gl.uniform1f(uniforms.uTime, time);
      gl.uniform1f(uniforms.uIntro, motion.matches ? 1 : Math.min(1, 0.65 + time / 2.4));
      gl.uniform1f(uniforms.uMotion, motion.matches ? 0 : 1);
      gl.uniform3f(uniforms.uPointer, pointerX, pointerY, pointerStrength);
      gl.uniform3f(uniforms.uClick, clickX, clickY, clickTime);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const frame = (now: number) => {
      raf = 0;
      if (disposed || lost || document.hidden || !visible) return;
      // Cap both the pixel ratio and frame rate for a temporary loading screen.
      if (!last || now - last >= 1000 / 30) {
        const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
        last = now;
        if (!motion.matches) time += dt;
        pointerStrength = Math.max(0, pointerStrength - dt / 0.7);
        draw();
      }
      if (!motion.matches) raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!raf && !disposed && !lost && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const resize = () => {
      const area = Math.max(1, canvas.clientWidth * canvas.clientHeight);
      ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(1920 * 1080 / area));
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      last = 0;
      wake();
    };
    const locate = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const height = Math.max(1, rect.height);
      pointerX = (event.clientX - rect.left - rect.width / 2) / height;
      pointerY = 0.5 - (event.clientY - rect.top) / height;
    };
    const onMove = (event: PointerEvent) => {
      if (motion.matches) return;
      locate(event);
      pointerStrength = 1;
      wake();
    };
    const onClick = (event: PointerEvent) => {
      if (motion.matches) return;
      locate(event);
      clickX = pointerX;
      clickY = pointerY;
      clickTime = time;
      wake();
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      wake();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      cancelAnimationFrame(raf);
      setAvailable(false);
    };
    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      onVisibility();
    });
    resizeObserver.observe(canvas);
    intersectionObserver.observe(canvas);
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onClick, { passive: true });
    canvas.addEventListener('webglcontextlost', onContextLost);
    document.addEventListener('visibilitychange', onVisibility);
    motion.addEventListener('change', onVisibility);
    resize();
    setAvailable(true);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onClick);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onVisibility);
      gl.deleteTexture(texture);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <div className="gradient-ascii" aria-hidden="true">
      <pre className="gradient-ascii__fallback">{'    . : = + x X x + = : .\n  . : + x X 0 S 8 S 0 X x + : .\n. : = x 0 S 8 # @ # 8 S 0 x = : .\n  . : + x X 0 S 8 S 0 X x + : .\n    . : = + x X x + = : .'}</pre>
      <canvas ref={canvasRef} className="gradient-ascii__canvas" data-ready={available || undefined} />
    </div>
  );
}
