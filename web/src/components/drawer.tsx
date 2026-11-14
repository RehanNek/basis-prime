'use client';
// A side panel for one action: from the right on a wide screen, from the bottom on a phone. Escape or the backdrop
// closes it.
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return createPortal(
    <>
      <div className="pb-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="pb-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pb-drawer-head">
          <h2>{title}</h2>
          <button type="button" className="pb-iconbtn ms-auto" aria-label="Close" onClick={onClose} autoFocus>
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </div>
        <div className="pb-drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}
