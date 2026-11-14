// The Perps page's frame (INTERFACES.md 49.1): the title, one line saying what the page is, and the grid a perps
// exchange uses. On a wide screen the chart is on the left, the book in the middle and the form on the right, with
// the tables below; on a phone they stack, the form straight after a short chart (perps.module.css).
import type { ReactNode } from 'react';

import { ORDER_FORM_ID } from './market-bar';
import s from './perps.module.css';

export const PERPS_LEAD = 'Trade perps on Hyperliquid from your account. Every order passes the broker’s risk checks first.';

interface Props {
  bar: ReactNode;
  chart: ReactNode;
  book: ReactNode;
  form: ReactNode;
  tables: ReactNode;
}

export function PerpsLayout({ bar, chart, book, form, tables }: Props) {
  return (
    <main className="pb-container pb-page" style={{ maxWidth: 1480 }}>
      <h1 className="h3">Perps</h1>
      <p className="lead" style={{ marginBottom: '1rem' }}>
        {PERPS_LEAD}
      </p>
      <div className={s.grid}>
        {bar}
        {chart}
        {book}
        <div className={s.form} id={ORDER_FORM_ID}>
          {form}
        </div>
        <div className={s.tables}>{tables}</div>
      </div>
    </main>
  );
}
