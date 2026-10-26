import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
const storageKey = 'control-plane-review-width';
export function useReviewWidth() {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return saved >= 320 && saved <= 1100 ? saved : 520;
    } catch {
      return 520;
    }
  });
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const maximum = Math.min(1100, Math.max(320, viewport - (viewport > 900 ? 560 : 32)));
  const width = Math.min(maximum, Math.max(320, preferred));
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function change(value: number) {
    const next = Math.round(Math.min(maximum, Math.max(320, value)));
    setPreferred(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* Layout remains usable without storage. */
    }
  }
  return {
    width,
    maximum,
    expand: () => change(width >= Math.min(900, maximum) ? 520 : Math.min(960, maximum)),
    separator: {
      role: 'separator',
      tabIndex: 0,
      'aria-label': '调整文件面板宽度',
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': 320,
      'aria-valuemax': maximum,
      'aria-valuenow': width,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current) change(drag.current.width + drag.current.x - event.clientX);
      },
      onPointerUp: () => {
        drag.current = undefined;
      },
      onPointerCancel: () => {
        drag.current = undefined;
      },
      onLostPointerCapture: () => {
        drag.current = undefined;
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        const next =
          event.key === 'ArrowLeft'
            ? width + 40
            : event.key === 'ArrowRight'
              ? width - 40
              : event.key === 'Home'
                ? 320
                : event.key === 'End'
                  ? maximum
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          change(next);
        }
      },
    },
  };
}
