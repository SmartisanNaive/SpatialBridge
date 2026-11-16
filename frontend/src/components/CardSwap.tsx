import {useRef, useState, type ReactNode} from 'react';
import {AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo} from 'motion/react';
import './CardSwap.css';

export type SwapCard = {id: string; content: ReactNode};

export default function CardSwap({items, activeId, onChange}: {
  items: SwapCard[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  const dragControls = useDragControls();
  const [leaving, setLeaving] = useState<{card: SwapCard; x: number; direction: number; token: number} | null>(null);
  const sequence = useRef(0);
  const active = Math.max(0, items.findIndex(item => item.id === activeId));
  const visible = Array.from({length: Math.min(4, items.length)}, (_, i) => items[(active + i) % items.length]);
  const shift = (direction: number, x = 0) => {
    if (items.length < 2) return;
    if (!reduce) setLeaving({card: items[active], x, direction, token: ++sequence.current});
    onChange(items[(active + direction + items.length) % items.length].id);
  };
  const finishDrag = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (Math.abs(info.offset.x) > 60 || Math.abs(info.velocity.x) > 500) {
      shift(info.offset.x < 0 ? 1 : -1, info.offset.x);
    }
  };
  return <div className="history-card-carousel" role="region" aria-roledescription="轮播" aria-label="历史项目卡片">
    <div className="card-swap" tabIndex={0} aria-label="使用左右方向键切换项目" onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        shift(event.key === 'ArrowRight' ? 1 : -1);
      }
    }}>
      {visible.map((card, position) => <motion.div
        key={card.id}
        className="card-swap-slot"
        data-front={position === 0 ? '' : undefined}
        aria-hidden={position !== 0}
        {...{inert: position === 0 ? undefined : ''}}
        style={{zIndex: 10 - position, pointerEvents: position === 0 ? 'auto' : 'none'}}
        initial={false}
        animate={{x: position * 17, y: -position * 20, z: -position * 55,
          rotate: position * 1.2, scale: 1, opacity: 1}}
        transition={reduce ? {duration: 0} : {type: 'spring', stiffness: 170, damping: 23}}
        drag={position === 0 && items.length > 1 ? 'x' : false}
        dragListener={false}
        dragControls={position === 0 ? dragControls : undefined}
        dragConstraints={{left: 0, right: 0}}
        dragElastic={.65}
        dragSnapToOrigin
        onPointerDown={event => {
          if (position === 0 && items.length > 1 && event.button === 0 &&
              !(event.target as Element).closest('button,a,input')) dragControls.start(event);
        }}
        onDragEnd={finishDrag}
      >
        {card.content}
        <span className="card-swap-shade" aria-hidden="true" style={{opacity: position * .08}} />
      </motion.div>)}
      <AnimatePresence>
        {leaving && <motion.div key={leaving.token} className="card-swap-slot card-swap-leaving" aria-hidden="true"
          ref={node => node?.setAttribute('inert', '')}
          initial={{x: leaving.x, y: 0, rotate: 0, opacity: 1}}
          animate={{x: leaving.x + leaving.direction * 35, y: 390, rotate: leaving.direction * 7, opacity: 0}}
          transition={{duration: .42, ease: [.22, .68, .3, 1]}}
          onAnimationComplete={() => setLeaving(current => current?.token === leaving.token ? null : current)}
        >{leaving.card.content}</motion.div>}
      </AnimatePresence>
    </div>
    <div className="card-swap-navigation">
      <button type="button" onClick={() => shift(-1)} disabled={items.length < 2} aria-label="上一个项目">←</button>
      <span aria-live="polite" aria-atomic="true">{items.length ? active + 1 : 0} / {items.length}</span>
      <button type="button" onClick={() => shift(1)} disabled={items.length < 2} aria-label="下一个项目">→</button>
    </div>
  </div>;
}
