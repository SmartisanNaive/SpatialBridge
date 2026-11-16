import {type CSSProperties, type ReactNode} from 'react';
import {motion, useReducedMotion} from 'motion/react';
import './StatusMark.css';

export type MarkStatus = 'pending' | 'running' | 'done' | 'failed' | 'paused' | 'cancelled';

const TEXT: Record<MarkStatus, string> = {
  pending: '等待中', running: '进行中', done: '已完成', failed: '失败', paused: '已暂停', cancelled: '已取消',
};

/** A quiet status glyph: dashed idle ring, progress ring, drawn check or cross, pause bars. */
export default function StatusMark({status = 'pending', progress, label, size = 18, fontSize = 12, className = ''}: {
  status?: MarkStatus;
  /** A fraction between zero and one; omit when progress cannot be measured. */
  progress?: number;
  label?: ReactNode;
  size?: number;
  fontSize?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const determinate = status === 'running' && typeof progress === 'number' && Number.isFinite(progress);
  const value = determinate ? Math.max(0, Math.min(1, progress)) : undefined;
  const indeterminate = status === 'running' && !determinate;
  const crossed = status === 'failed' || status === 'cancelled';
  const circumference = 2 * Math.PI * 9;
  const arc = indeterminate ? .68 : value ?? 1;
  const dash = status === 'pending' || status === 'cancelled'
    ? circumference / 8 * .3 : circumference * arc;
  const gap = status === 'pending' || status === 'cancelled'
    ? circumference / 8 * .7 : circumference * (1 - arc);
  const hasLabel = label !== undefined && label !== null;
  const spoken = TEXT[status] + (value !== undefined ? `，${Math.round(value * 100)}%` : '');
  const morph = {duration: reduce ? 0 : .55, ease: [.77, 0, .175, 1] as const};
  // Slow, deliberate draw so the finished glyph is always fully seen.
  const draw = {...morph, duration: reduce ? 0 : .65, delay: reduce ? 0 : .25};
  return <span className={`status-mark${className ? ` ${className}` : ''}`} data-status={status}
    data-indeterminate={indeterminate ? '' : undefined}
    role={determinate ? 'progressbar' : undefined}
    aria-label={determinate ? (typeof label === 'string' ? label : TEXT[status]) : undefined}
    aria-valuemin={determinate ? 0 : undefined} aria-valuemax={determinate ? 100 : undefined}
    aria-valuenow={value !== undefined ? Math.round(value * 100) : undefined}
    style={{'--sm-size': `${size}px`, '--sm-font': `${fontSize}px`} as CSSProperties}>
    <svg className="status-mark__glyph" viewBox="0 0 24 24" width={size} height={size}
      role={!hasLabel && !determinate ? 'img' : undefined}
      aria-label={!hasLabel && !determinate ? spoken : undefined} aria-hidden={hasLabel || determinate || undefined}>
      <circle className="status-mark__track" cx="12" cy="12" r="9" />
      <motion.circle className="status-mark__ring" cx="12" cy="12" r="9" transform="rotate(-90 12 12)"
        initial={false} animate={{strokeDasharray: `${dash} ${gap}`}} transition={morph} />
      <motion.path className="status-mark__check" d="M7.5 12.25 10.5 15.25 16.75 8.75" pathLength={1}
        initial={false} animate={{pathLength: status === 'done' ? 1 : 0, opacity: status === 'done' ? 1 : 0}}
        transition={draw} />
      <motion.path className="status-mark__cross" d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" pathLength={1}
        initial={false} animate={{pathLength: crossed ? 1 : 0, opacity: crossed ? 1 : 0}} transition={draw} />
      <path className="status-mark__pause" d="M9.5 8.5v7M14.5 8.5v7" />
    </svg>
    {hasLabel && <span className="status-mark__label">
      {!determinate && <span className="status-mark__sr">{spoken}：</span>}{label}
    </span>}
  </span>;
}
