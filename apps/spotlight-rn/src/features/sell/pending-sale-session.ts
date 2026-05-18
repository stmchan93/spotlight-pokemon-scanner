import type { PortfolioSaleRequestPayload } from '@spotlight/api-client';

let pendingPayload: PortfolioSaleRequestPayload | null = null;

export function setPendingSalePayload(payload: PortfolioSaleRequestPayload): void {
  pendingPayload = payload;
}

export function consumePendingSalePayload(): PortfolioSaleRequestPayload | null {
  const payload = pendingPayload;
  pendingPayload = null;
  return payload;
}
