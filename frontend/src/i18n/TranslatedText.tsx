import {Fragment, useLayoutEffect, useRef, useState} from 'react';
import {useI18n} from './I18nContext';
import './TranslatedText.css';

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DURATION = 480;
const STEP = 40;

interface RevealFrame {
  text: string;
  language: string;
  progress: number;
  iteration: number;
}

/** Only language changes scramble text; live data updates stay immediate. */
export function TranslatedText({text}: {text: string | number}) {
  const {language} = useI18n();
  const target = String(text);
  const previous = useRef({language, text: target});
  const [frame, setFrame] = useState<RevealFrame | null>(null);

  useLayoutEffect(() => {
    const changed = previous.current.language !== language && previous.current.text !== target;
    previous.current = {language, text: target};
    setFrame(null);
    if (!changed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const start = performance.now();
    let timer: ReturnType<typeof setInterval>;
    const finish = () => {
      clearInterval(timer);
      setFrame(null);
    };
    setFrame({text: target, language, progress: 0, iteration: 0});
    timer = setInterval(() => {
      const elapsed = performance.now() - start;
      if (elapsed >= DURATION) {
        finish();
      } else {
        setFrame({text: target, language, progress: elapsed / DURATION, iteration: Math.floor(elapsed / STEP)});
      }
    }, STEP);
    motionPreference.addEventListener('change', finish);
    return () => {
      clearInterval(timer);
      motionPreference.removeEventListener('change', finish);
    };
  }, [language, target]);

  if (!frame || frame.language !== language || frame.text !== target) return <>{target}</>;

  const chars = Array.from(target);
  let position = 0;
  return <span className="translated-text">
    <span className="translated-text__accessible">{target}</span>
    <span aria-hidden="true">
      {target.split(/(\s+)/u).map((word, group) => {
        const offset = position;
        position += Array.from(word).length;
        if (/^\s+$/u.test(word)) return <Fragment key={group}>{word}</Fragment>;
        return <span key={group} className={/^[\x00-\x7F]+$/u.test(word) ? 'translated-text__word' : undefined}>
          {Array.from(word).map((char, index) => {
            const rank = (offset + index) / Math.max(1, chars.length - 1);
            const revealAt = 0.14 + rank * 0.46;
            const revealed = frame.progress >= revealAt;
            const glyph = GLYPHS[(char.codePointAt(0)! + index * 7 + frame.iteration * 11) % GLYPHS.length];
            return <span key={index} className={`translated-text__cell${revealed ? ' is-revealed' : ''}`}>
              <span className="translated-text__ghost">{char}</span>
              <span className="translated-text__glyph">{revealed ? char : glyph}</span>
            </span>;
          })}
        </span>;
      })}
    </span>
  </span>;
}
