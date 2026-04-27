import { MockSpotlightRepository } from '@spotlight/api-client';

describe('MockSpotlightRepository', () => {
  it('rebuilds the portfolio summary after inventory is added', async () => {
    const repository = new MockSpotlightRepository();

    expect((await repository.getPortfolioDashboard()).summary).toMatchObject({
      currentValue: 194.61,
      changeAmount: 112.2,
      changePercent: 136.15,
    });

    await repository.createPortfolioBuy({
      boughtAt: '2026-04-24T12:00:00.000Z',
      cardID: 'sm7-1',
      condition: 'near_mint',
      currencyCode: 'USD',
      paymentMethod: null,
      quantity: 1,
      slabContext: null,
      sourceScanID: null,
      unitPrice: 0.31,
    });

    const dashboard = await repository.getPortfolioDashboard();

    expect(dashboard.summary.currentValue).toBe(194.92);
    expect(dashboard.summary.changeAmount).toBe(112.51);
    expect(dashboard.summary.changePercent).toBe(136.52);
    expect(dashboard.ranges['7D'].portfolio[dashboard.ranges['7D'].portfolio.length - 1]?.value).toBe(194.92);
    expect(dashboard.recentSales[0]?.kind).toBe('traded');
  });

  it('rebuilds the sales chart totals after a sale is recorded', async () => {
    const repository = new MockSpotlightRepository();

    await repository.createPortfolioSale({
      cardID: 'mcdonalds25-16',
      currencyCode: 'USD',
      note: null,
      paymentMethod: null,
      quantity: 1,
      showSessionID: null,
      slabContext: null,
      soldAt: '2026-04-21T14:00:00.000Z',
      sourceScanID: null,
      unitPrice: 2,
    });

    const dashboard = await repository.getPortfolioDashboard();
    const grossSales7d = dashboard.ranges['7D'].sales.reduce((sum, point) => sum + point.value, 0);

    expect(dashboard.summary.currentValue).toBe(194.23);
    expect(dashboard.recentSales[0]?.soldPrice).toBe(2);
    expect(dashboard.recentSales[0]?.kind).toBe('sold');
    expect(Number(grossSales7d.toFixed(2))).toBe(100.1);
  });
});
