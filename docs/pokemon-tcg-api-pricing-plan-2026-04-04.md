# Pokemon TCG API + PriceCharting Pricing Plan

Superseded: current runtime rules live in [AGENTS.md](/Users/stephenchan/Code/spotlight/AGENTS.md), [PLAN.md](/Users/stephenchan/Code/spotlight/PLAN.md), and [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md).
This file is historical planning context only.

Date: 2026-04-04

## Objective

Reconfigure the pricing provider architecture to use:
- **Pokemon TCG API** for raw/singles pricing (free, official, using provided API key)
- **PriceCharting** for PSA slab pricing (specialized graded pricing)
- **Scrydex** as fallback for both (when configured)

## Current State

The existing provider abstraction supports this architecture:
- `PricingProvider` contract with `supports_raw_pricing` and `supports_psa_pricing` flags
- `PricingProviderRegistry` that can route raw and PSA to different providers
- Registry tries providers in order until one succeeds

Currently registered:
1. PriceCharting (both raw and PSA)
2. Scrydex (both raw and PSA)

## Target State

New provider registration order:
1. **PokemonTcgApiProvider** (raw only, priority 1)
2. **PriceChartingProvider** (PSA only, priority 1)
3. **ScrydexProvider** (both raw and PSA, fallback)

Routing behavior:
- Raw card refresh → tries PokemonTcgApi first, then Scrydex
- PSA slab refresh → tries PriceCharting first, then Scrydex

## Architecture Principles

### 1. Reusable Shared Layer

Create `backend/pricing_utils.py` with shared utilities:

```python
def normalize_tcgplayer_prices(tcgplayer_block: dict) -> dict:
    """Extract and normalize tcgplayer pricing."""
    # Reusable across Pokemon TCG API provider and import code
    pass

def normalize_cardmarket_prices(cardmarket_block: dict) -> dict:
    """Extract and normalize cardmarket pricing."""
    # Reusable across providers
    pass

def select_best_price_source(tcgplayer: dict | None, cardmarket: dict | None) -> dict:
    """Choose best price source from available data."""
    # Prefer tcgplayer, fallback to cardmarket
    pass
```

### 2. Provider Specialization

Each provider declares its capabilities:

```python
class PokemonTcgApiProvider(PricingProvider):
    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id="pokemontcg_api",
            provider_label="Pokemon TCG API",
            is_ready=self.is_ready(),
            requires_credentials=True,  # API key required
            supports_raw_pricing=True,   # ✅ Supports raw
            supports_psa_pricing=False,  # ❌ Does not support PSA
        )
```

```python
class PriceChartingProvider(PricingProvider):
    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id="pricecharting",
            provider_label="PriceCharting",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=False,  # ❌ Does not support raw
            supports_psa_pricing=True,   # ✅ Supports PSA
        )
```

### 3. Registry Routing

The registry already handles this correctly:

```python
# In PricingProviderRegistry
def get_active_provider(self, *, for_raw: bool = True, for_psa: bool = False):
    for provider in self._providers:
        if not provider.is_ready():
            continue
        metadata = provider.get_metadata()
        if for_raw and metadata.supports_raw_pricing:
            return provider  # Returns PokemonTcgApi for raw
        if for_psa and metadata.supports_psa_pricing:
            return provider  # Returns PriceCharting for PSA
    return None
```

## Implementation Details

### Task 1: Extract Shared Utilities

The codebase already has Pokemon TCG API pricing logic in:
- `import_pokemontcg_catalog.py` - card import and mapping
- `catalog_tools.py` - price normalization in `seed_catalog()`

Extract to `backend/pricing_utils.py`:

```python
def normalize_tcgplayer_prices(tcgplayer: dict | None) -> dict | None:
    """
    Normalize tcgplayer price block to our schema.

    Returns dict with: low, market, mid, high, directLow, trend, currency
    """
    if not tcgplayer or not isinstance(tcgplayer, dict):
        return None

    prices = tcgplayer.get("prices", {})
    if not prices:
        return None

    # Try holofoil first, then normal, then any available
    for variant in ["holofoil", "normal", "1stEditionHolofoil", "unlimitedHolofoil"]:
        if variant in prices and prices[variant]:
            p = prices[variant]
            return {
                "low": p.get("low"),
                "market": p.get("market"),
                "mid": p.get("mid"),
                "high": p.get("high"),
                "directLow": p.get("directLow"),
                "trend": None,
                "currency": "USD",
                "variant": variant,
            }

    return None

def normalize_cardmarket_prices(cardmarket: dict | None) -> dict | None:
    """Normalize cardmarket price block to our schema."""
    if not cardmarket or not isinstance(cardmarket, dict):
        return None

    prices = cardmarket.get("prices", {})
    if not prices:
        return None

    return {
        "low": prices.get("lowPrice"),
        "market": prices.get("averageSellPrice"),
        "mid": prices.get("trendPrice"),
        "high": prices.get("suggestedPrice"),
        "directLow": None,
        "trend": prices.get("trendPrice"),
        "currency": "EUR",
        "variant": "normal",
    }
```

### Task 2: Create PokemonTcgApiProvider

New file: `backend/pokemontcg_pricing_adapter.py`

```python
from pricing_provider import (
    PricingProvider,
    ProviderMetadata,
    RawPricingResult,
    PsaPricingResult,
)
from pricing_utils import (
    normalize_tcgplayer_prices,
    normalize_cardmarket_prices,
)
from import_pokemontcg_catalog import fetch_card_by_id

class PokemonTcgApiProvider(PricingProvider):
    """Pokemon TCG API pricing provider for raw cards."""

    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id="pokemontcg_api",
            provider_label="Pokemon TCG API",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=True,
            supports_psa_pricing=False,  # Does not support PSA
        )

    def is_ready(self) -> bool:
        api_key = os.environ.get("POKEMONTCG_API_KEY", "").strip()
        return bool(api_key)

    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        # Use existing fetch_card_by_id and normalize with shared utils
        # Persist with upsert_card_price_summary
        pass

    def refresh_psa_pricing(self, connection, card_id: str, grade: str) -> PsaPricingResult:
        # Not supported
        return PsaPricingResult(
            success=False,
            provider_id="pokemontcg_api",
            card_id=card_id,
            grade=grade,
            error="Pokemon TCG API does not support PSA graded pricing",
        )
```

### Task 3: Update PriceCharting

Modify `backend/pricecharting_adapter.py`:

```python
class PriceChartingProvider(PricingProvider):
    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id="pricecharting",
            provider_label="PriceCharting",
            is_ready=self.is_ready(),
            requires_credentials=True,
            supports_raw_pricing=False,  # Changed from True
            supports_psa_pricing=True,
        )

    def refresh_raw_pricing(self, connection, card_id: str) -> RawPricingResult:
        # Not supported anymore
        return RawPricingResult(
            success=False,
            provider_id="pricecharting",
            card_id=card_id,
            error="PriceCharting is configured for PSA pricing only. Use Pokemon TCG API for raw cards.",
        )
```

### Task 4: Update Server Registration

Modify `backend/server.py`:

```python
from pokemontcg_pricing_adapter import PokemonTcgApiProvider
from pricecharting_adapter import PriceChartingProvider
from scrydex_adapter import ScrydexProvider

# In SpotlightScanService.__init__:
self.pricing_registry = PricingProviderRegistry()
self.pricing_registry.register(PokemonTcgApiProvider())  # Raw pricing
self.pricing_registry.register(PriceChartingProvider())  # PSA pricing
self.pricing_registry.register(ScrydexProvider())        # Fallback for both
```

## Fallback Behavior

### Raw Card Pricing

1. Try `PokemonTcgApiProvider` (if `POKEMONTCG_API_KEY` configured)
2. Try `ScrydexProvider` (if `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` configured)
3. Fall back to imported snapshot cache

### PSA Slab Pricing

1. Try `PriceChartingProvider` (if `PRICECHARTING_API_KEY` configured)
2. Try `ScrydexProvider` (if `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` configured)
3. Fall back to local slab comp model
4. Fall back to raw proxy

## Configuration

```bash
# Required for raw pricing
export POKEMONTCG_API_KEY=fb7ee110-01d4-4998-875a-aec3ef50b78a

# Required for PSA pricing
export PRICECHARTING_API_KEY=your_pricecharting_key

# Optional: Scrydex fallback
export SCRYDEX_API_KEY=your_scrydex_key
export SCRYDEX_TEAM_ID=your_team_id
```

## Benefits

1. **Free raw pricing** - Pokemon TCG API is free for non-commercial use
2. **Official data** - Pokemon TCG API is the official source
3. **Specialized PSA pricing** - PriceCharting focuses on graded cards
4. **Clean separation** - Each provider has a clear, focused responsibility
5. **Reusable utilities** - Shared price normalization code
6. **Existing code preserved** - Can still use Pokemon TCG API for catalog import

## Risks and Mitigations

### Risk 1: Pokemon TCG API rate limits
- **Mitigation**: Implement rate limit handling in provider
- **Mitigation**: Use cached snapshots as fallback

### Risk 2: Different price formats between providers
- **Mitigation**: Shared utilities normalize to common schema
- **Mitigation**: Comprehensive test coverage for normalization

### Risk 3: Provider availability
- **Mitigation**: Multi-provider fallback chain
- **Mitigation**: Local snapshot cache as final fallback

## Testing Strategy

1. **Unit tests** for each provider
2. **Integration tests** for registry routing
3. **Live tests** with real API key
4. **Fallback tests** when providers fail
5. **Price normalization tests** for shared utilities

## Success Criteria

✅ Pokemon TCG API provider works for raw cards
✅ PriceCharting provider works for PSA slabs
✅ Registry correctly routes raw to Pokemon TCG API
✅ Registry correctly routes PSA to PriceCharting
✅ Scrydex fallback works for both
✅ Shared utilities are reusable
✅ All tests pass
✅ Documentation updated

## Execution Order

1. Create `backend/pricing_utils.py` with shared normalization
2. Create `backend/pokemontcg_pricing_adapter.py`
3. Update `backend/pricecharting_adapter.py` to PSA-only
4. Update `backend/server.py` provider registration
5. Update tests
6. Validate with live API key
7. Run full validation suite
8. Update documentation
