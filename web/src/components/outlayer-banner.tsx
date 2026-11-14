'use client';
// The banner under the tabs, on every page, while OutLayer's testnet is slow or silent (INTERFACES.md 51.15). It says
// who is being waited on, what the backend last saw, and that nothing is lost. With OutLayer answering well, or with
// nothing known, there is no banner.
import { useNow } from '@/hooks/use-now';
import { useOutlayer } from '@/hooks/use-outlayer';
import { bannerWords } from '@/lib/outlayer';

export function OutlayerBanner() {
  const health = useOutlayer();
  const now = useNow(10_000);
  const banner = bannerWords(health, now);
  if (!banner) return null;
  return (
    <div className="pb-container mt-3" role="status">
      <div className={`alert ${banner.tone === 'bad' ? 'alert-danger' : 'alert-warning'} small mb-0`}>
        <span className="fw-semibold">{banner.headline}</span> {banner.detail} {banner.body}
      </div>
    </div>
  );
}
