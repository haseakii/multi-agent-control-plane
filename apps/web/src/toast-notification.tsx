import { useEffect, useState } from 'react';

export type ToastType = 'info' | 'success' | 'error';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

type ToastListener = (toasts: ToastItem[]) => void;

class ToastManager {
  private toasts: ToastItem[] = [];
  private listeners: Set<ToastListener> = new Set();

  subscribe(listener: ToastListener) {
    this.listeners.add(listener);
    listener([...this.toasts]);
    return () => {
      this.listeners.delete(listener);
    };
  }

  show(message: string, type: ToastType = 'info', duration = 4000) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const toast: ToastItem = { id, type, message, duration };
    this.toasts = [toast, ...this.toasts.slice(0, 4)]; // Max 5 toasts
    this.notify();

    if (duration > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }
    return id;
  }

  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener([...this.toasts]);
    }
  }
}

export const toast = new ToastManager();

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    return toast.subscribe(setToasts);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={`toast-item toast-${item.type}`}>
          <span className="toast-icon" aria-hidden="true">
            {item.type === 'success' ? '✓' : item.type === 'error' ? '!' : 'ℹ'}
          </span>
          <span className="toast-message">{item.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="关闭通知"
            onClick={() => toast.dismiss(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
