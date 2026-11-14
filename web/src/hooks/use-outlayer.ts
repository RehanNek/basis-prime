'use client';
// How OutLayer is answering (INTERFACES.md 51.15, GET /api/outlayer), read every 20 seconds. It needs no wallet and
// names no account. A backend without the route answers an error, which reads as "nothing known": no banner.
import { useApi } from '@/hooks/use-api';
import { OUTLAYER_PATH, type OutlayerHealth } from '@/lib/outlayer';

export function useOutlayer(): OutlayerHealth | undefined {
  return useApi<OutlayerHealth>(OUTLAYER_PATH, 20_000).data;
}
