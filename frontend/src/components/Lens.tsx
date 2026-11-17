import React, {useState, useRef, useCallback} from 'react';
import {motion, AnimatePresence} from 'motion/react';
import {useI18n} from '../i18n';

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

export interface LensProps {
  children: React.ReactNode;
  zoomFactor?: number;
  lensSize?: number;
  hovering?: boolean;
  setHovering?: (hovering: boolean) => void;
  className?: string;
  lensClassName?: string;
  ariaLabel?: string;
}

export function Lens({
  children,
  zoomFactor = 2.4,
  lensSize = 140,
  hovering: controlledHovering,
  setHovering: setControlledHovering,
  className,
  lensClassName,
  ariaLabel,
}: LensProps) {
  const {t} = useI18n();
  const effectiveAriaLabel = ariaLabel ?? t.lens.ariaLabel;
  const [internalHovering, setInternalHovering] = useState(false);
  const isHovered = controlledHovering !== undefined ? controlledHovering : internalHovering;
  const setHovered = setControlledHovering || setInternalHovering;

  const [mousePos, setMousePos] = useState<{x: number; y: number}>({x: 0, y: 0});
  const containerRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(clientY - rect.top, rect.height));
    setMousePos({x, y});
  }, []);

  const handlePointerEnter = (e: React.PointerEvent) => {
    setHovered(true);
    updatePosition(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    updatePosition(e.clientX, e.clientY);
  };

  const handlePointerLeave = () => {
    setHovered(false);
  };

  const halfSize = lensSize / 2;

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={effectiveAriaLabel}
      className={cn('lens-container', className)}
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {/* 原始内容容器 */}
      <div className="lens-content-wrapper">{children}</div>

      {/* 浮动透镜 */}
      <AnimatePresence>
        {isHovered && (
          <motion.div
            initial={{opacity: 0, scale: 0.6}}
            animate={{opacity: 1, scale: 1}}
            exit={{opacity: 0, scale: 0.6}}
            transition={{duration: 0.16, ease: 'easeOut'}}
            className={cn('lens-glass', lensClassName)}
            style={{
              width: lensSize,
              height: lensSize,
              left: mousePos.x - halfSize,
              top: mousePos.y - halfSize,
            }}
          >
            {/* 放大的图层 */}
            <div
              className="lens-zoomed-view"
              style={{
                width: containerRef.current ? containerRef.current.offsetWidth : '100%',
                height: containerRef.current ? containerRef.current.offsetHeight : '100%',
                transform: `translate(${-mousePos.x * zoomFactor + halfSize}px, ${-mousePos.y * zoomFactor + halfSize}px) scale(${zoomFactor})`,
                transformOrigin: '0 0',
              }}
            >
              {children}
            </div>

            {/* 透镜光晕与中心质谱标尺准星 */}
            <div className="lens-overlay">
              <div className="lens-crosshair-h" />
              <div className="lens-crosshair-v" />
              <div className="lens-target-ring" />
              <span className="lens-zoom-badge">{zoomFactor.toFixed(1)}×</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// 科技紫色背景光束 Beams
export const Beams = ({className}: {className?: string}) => {
  return (
    <svg
      width="380"
      height="315"
      viewBox="0 0 380 315"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('beams-svg', className)}
      aria-hidden="true"
    >
      <g filter="url(#sb_beam_filter0)">
        <circle cx="34" cy="52" r="114" fill="#6925E7" />
      </g>
      <g filter="url(#sb_beam_filter1)">
        <circle cx="332" cy="24" r="102" fill="#8A4BFF" />
      </g>
      <g filter="url(#sb_beam_filter2)">
        <circle cx="191" cy="53" r="102" fill="#802FE3" />
      </g>
      <defs>
        <filter
          id="sb_beam_filter0"
          x="-192"
          y="-174"
          width="452"
          height="452"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="56" result="blur0" />
        </filter>
        <filter
          id="sb_beam_filter1"
          x="70"
          y="-238"
          width="524"
          height="524"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="80" result="blur1" />
        </filter>
        <filter
          id="sb_beam_filter2"
          x="-71"
          y="-209"
          width="524"
          height="524"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="80" result="blur2" />
        </filter>
      </defs>
    </svg>
  );
};

// 科技紫色背景光线 Rays
export const Rays = ({className}: {className?: string}) => {
  return (
    <svg
      width="380"
      height="397"
      viewBox="0 0 380 397"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('rays-svg', className)}
      aria-hidden="true"
    >
      <g filter="url(#sb_ray_filter0)">
        <path
          d="M-37.4202 -76.0163L-18.6447 -90.7295L242.792 162.228L207.51 182.074L-37.4202 -76.0163Z"
          fill="url(#sb_ray_paint0)"
        />
      </g>
      <g style={{mixBlendMode: 'plus-lighter'}} opacity="0.3" filter="url(#sb_ray_filter1)">
        <path
          d="M-109.54 -36.9027L-84.2903 -58.0902L178.786 193.228L132.846 223.731L-109.54 -36.9027Z"
          fill="url(#sb_ray_paint1)"
        />
      </g>
      <g style={{mixBlendMode: 'plus-lighter'}} opacity="0.86" filter="url(#sb_ray_filter2)">
        <path
          d="M-100.647 -65.795L-69.7261 -92.654L194.786 157.229L139.51 197.068L-100.647 -65.795Z"
          fill="url(#sb_ray_paint2)"
        />
      </g>
      <g style={{mixBlendMode: 'plus-lighter'}} opacity="0.31" filter="url(#sb_ray_filter3)">
        <path
          d="M163.917 -89.0982C173.189 -72.1354 80.9618 2.11525 34.7334 30.1553C-11.495 58.1954 -106.505 97.514 -115.777 80.5512C-125.048 63.5885 -45.0708 -3.23233 1.15763 -31.2724C47.386 -59.3124 154.645 -106.061 163.917 -89.0982Z"
          fill="#8A50FF"
        />
      </g>
      <g style={{mixBlendMode: 'plus-lighter'}} filter="url(#sb_ray_filter4)">
        <path d="M34.2031 13.2222L291.721 269.534" stroke="url(#sb_ray_paint3)" />
      </g>
      <g style={{mixBlendMode: 'plus-lighter'}} filter="url(#sb_ray_filter5)">
        <path d="M41 -40.9331L298.518 215.378" stroke="url(#sb_ray_paint4)" />
      </g>
      <g style={{mixBlendMode: 'plus-lighter'}} filter="url(#sb_ray_filter6)">
        <path d="M61.3691 3.8999L317.266 261.83" stroke="url(#sb_ray_paint5)" />
      </g>
      <g style={{mixBlendMode: 'plus-lighter'}} filter="url(#sb_ray_filter7)">
        <path d="M-1.46191 9.06348L129.458 145.868" stroke="url(#sb_ray_paint6)" strokeWidth="2" />
      </g>
      <defs>
        <filter id="sb_ray_filter0" x="-49.4199" y="-102.729" width="304.212" height="296.803" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter id="sb_ray_filter1" x="-115.54" y="-64.0903" width="300.326" height="293.822" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id="sb_ray_filter2" x="-111.647" y="-103.654" width="317.434" height="311.722" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="5.5" />
        </filter>
        <filter id="sb_ray_filter3" x="-212.518" y="-188.71" width="473.085" height="369.366" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="48" />
        </filter>
        <filter id="sb_ray_filter4" x="25.8447" y="4.84521" width="274.234" height="273.065" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter id="sb_ray_filter5" x="32.6416" y="-49.3101" width="274.234" height="273.065" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter id="sb_ray_filter6" x="54.0078" y="-3.47461" width="270.619" height="272.68" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="3.5" />
        </filter>
        <filter id="sb_ray_filter7" x="-9.2002" y="1.32812" width="146.396" height="152.275" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="3.5" />
        </filter>
        <linearGradient id="sb_ray_paint0" x1="-57.5042" y1="-134.741" x2="403.147" y2="351.523" gradientUnits="userSpaceOnUse">
          <stop offset="0.214779" stopColor="#AF53FF" />
          <stop offset="0.781583" stopColor="#B253FF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sb_ray_paint1" x1="-122.154" y1="-103.098" x2="342.232" y2="379.765" gradientUnits="userSpaceOnUse">
          <stop offset="0.214779" stopColor="#AF53FF" />
          <stop offset="0.781583" stopColor="#9E53FF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sb_ray_paint2" x1="-106.717" y1="-138.534" x2="359.545" y2="342.58" gradientUnits="userSpaceOnUse">
          <stop offset="0.214779" stopColor="#9D53FF" />
          <stop offset="0.781583" stopColor="#A953FF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sb_ray_paint3" x1="72.701" y1="54.347" x2="217.209" y2="187.221" gradientUnits="userSpaceOnUse">
          <stop stopColor="#AF81FF" />
          <stop offset="1" stopColor="#C081FF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sb_ray_paint4" x1="79.4978" y1="0.191681" x2="224.006" y2="133.065" gradientUnits="userSpaceOnUse">
          <stop stopColor="#AF81FF" />
          <stop offset="1" stopColor="#C081FF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sb_ray_paint5" x1="79.6568" y1="21.8377" x2="234.515" y2="174.189" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B981FF" />
          <stop offset="1" stopColor="#CF81FF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sb_ray_paint6" x1="16.119" y1="27.6966" x2="165.979" y2="184.983" gradientUnits="userSpaceOnUse">
          <stop stopColor="#A981FF" />
          <stop offset="1" stopColor="#CB81FF" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};
