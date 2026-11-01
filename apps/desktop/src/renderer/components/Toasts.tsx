import { useEffect, useState } from 'react';

type ToastItem = { id: number; text: string; kind: 'info' | 'error' };
let listeners: ((t: ToastItem) => void)[] = [];
let nextId = 1;

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const t = { id: nextId++, text, kind };
  listeners.forEach((l) => l(t));
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const l = (t: ToastItem) => {
      setItems((list) => [...list.slice(-2), t]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== t.id)), 3500);
    };
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);
  return (
    <div className="toasts" role="status">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
