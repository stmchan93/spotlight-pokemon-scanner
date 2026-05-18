import type { PortfolioSaleRequestPayload } from '@spotlight/api-client';

let pendingPayload: PortfolioSaleRequestPayload | null = null;
let pendingBatchPayloads: PortfolioSaleRequestPayload[] | null = null;

export function setPendingSalePayload(payload: PortfolioSaleRequestPayload): void {
  pendingPayload = payload;
  pendingBatchPayloads = null;
}

export function consumePendingSalePayload(): PortfolioSaleRequestPayload | null {
  const payload = pendingPayload;
  pendingPayload = null;
  return payload;
}

export function setPendingBatchSalePayloads(payloads: PortfolioSaleRequestPayload[]): void {
  pendingBatchPayloads = payloads;
  pendingPayload = null;
}

export function consumePendingBatchSalePayloads(): PortfolioSaleRequestPayload[] | null {
  const payloads = pendingBatchPayloads;
  pendingBatchPayloads = null;
  return payloads;
}
