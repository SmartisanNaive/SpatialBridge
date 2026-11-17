import { useEffect, useRef } from 'react';

import { TranslatedText } from '../i18n';
import './CubeLoader.css';

const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'] as const;

interface CubeLoaderProps {
  label: string;
}

export default function CubeLoader({ label }: CubeLoaderProps) {
  const timerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const deciseconds = Math.floor((performance.now() - startedAt) / 100);
      const seconds = ((deciseconds % 600) / 10).toFixed(1);
      if (timerRef.current) {
        timerRef.current.textContent = deciseconds < 600
          ? `${seconds}s`
          : `${Math.floor(deciseconds / 600)}m ${seconds}s`;
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="cube-loader">
      <div className="cube-loader__scene" aria-hidden="true">
        <div className="cube-loader__cube">
          <div className="cube-loader__core" />
          {FACES.map((face) => (
            <div key={face} className={`cube-loader__side cube-loader__side--${face}`}>
              <div className="cube-loader__face" />
            </div>
          ))}
        </div>
        <div className="cube-loader__shadow" />
      </div>
      <div className="cube-loader__content">
        <span className="cube-loader__label" role="status">
          <TranslatedText text={label} />
        </span>
        <span ref={timerRef} className="cube-loader__timer" aria-hidden="true">0.0s</span>
      </div>
    </div>
  );
}
