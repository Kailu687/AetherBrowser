import { useEffect, useRef, type ReactNode } from 'react';

/** Click-outside / Escape-aware floating panel. */
export function Popover({ className, onClose, children }: { className: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const id = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`popover ${className}`} role="dialog">
      {children}
    </div>
  );
}
