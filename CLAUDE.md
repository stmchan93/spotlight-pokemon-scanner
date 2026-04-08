# Spotlight Card Scanner - Development Log

Last updated: 2026-04-06

## Current Status

iOS card scanning app with **PRODUCTION** Google Cloud Run backend. Camera scanner for Pokémon trading cards with real-time pricing from **Scrydex**.

## Critical Outstanding Issues

### 1. Camera Black Screen on Launch ❌
**Problem:** Camera shows black screen when app launches on physical iPhone (iOS 18.3.1)
- Camera permission IS granted in Settings
- Xcode loses connection to device during deployment
- App may be crashing immediately on launch

**What we tried:**
- Added camera permission to Info.plist ✓
- Fixed camera session initialization timing
- Added eager camera startup in AppContainer.init()
- Added extensive logging to debug authorization flow
- Removed auto-zoom that was causing capture mismatch

**Debug logging added:**
- Look for `📷 [CAMERA]` logs in Xcode console
- Check authorization status, configuration, and session start

**Next steps:**
1. Ensure stable USB connection to device
2. Keep iPhone unlocked during deployment
3. Check Xcode console for camera logs to identify failure point
4. May need to investigate immediate crash on launch

### 2. Memory Crashes (FIXED ✓)
**Problem:** App killed by OS for excessive memory usage after 18-90 seconds

**Root cause:** Full-resolution images stored in scan stack
- Each scanned card kept 3 copies of ~12MP images
- Debug mode was saving images to disk

**Fixes applied:**
- Disabled debug image saving (`.disabled`)
- Downscale all preview images to 300px max dimension (~95% memory reduction)
- Limit scan stack to 20 items maximum
- Never replace thumbnails with full-res images

**Result:** Memory usage reduced from ~100MB+ to ~10MB

## Recent Changes

### UI Redesign to Match Reference (2026-04-05)
- **Full-screen camera preview**: Camera now takes up most of the screen with lighter gradients for better visibility
- **Larger reticle**: Increased scanning area to 340x476 with lime green corners (matching reference design)
- **Tap-to-scan area**: Restricted to reticle area only (340x476 rectangle)
- **Bottom scan tray**: Compact tray at bottom with "Recent scans" + CLEAR button on left, running total on right
- **Chevron expand button**: Floating chevron-up button above tray to expand/collapse
- **Compact card rows**: Shows thumbnail, card info, QTY 1, and ADD button in horizontal layout
- **Single card default**: Only shows most recent scan when collapsed, all scans when expanded
- **Dark theme**: Black background (not dark gray) for cleaner look

### UI Simplification
- Removed "Live Scan Stack" subtitle
- Changed to simple "Spotlight" title
- Removed all control buttons from scanner view (import, torch, flashlight)
- Added import button to top-right of main screen only
- Removed bottom circular scan button

### Scanner Fixes
- Fixed photo zoom out issue (changed preview from `.resizeAspectFill` to `.resizeAspect`)
- Fixed OCR region targeting (moved to y: 0.93, last 6% of card for identifier strip)
- Removed confidence gating - always accept best match
- Hidden confidence labels in UI

### Backend Configuration

**iOS app automatically switches backends based on build configuration:**

#### Debug (Xcode → Device/Simulator)
- **Backend URL:** `http://192.168.0.225:8788/` (Mac's local IP)
- **Use for:** Daily development, testing, debugging
- **Cost:** FREE (runs on your Mac)
- **Setup:** Run `python3 backend/server.py --skip-seed --port 8788` locally

#### Release (Archive → TestFlight/App Store)
- **Backend URL:** `https://spotlight-backend-grhsfspaia-uc.a.run.app/`
- **Hosting:** Google Cloud Run (us-central1)
- **Use for:** Testing with friends, production deployment
- **Cost:** Pay-per-use (scales to zero when idle)
- **Pricing Provider:** Scrydex (primary for both raw cards and PSA slabs)
- **Database:** SQLite (starts empty, auto-populates on card requests)
- **Environment Variables:** Set via deploy.sh from backend/.env
  - `SCRYDEX_API_KEY`: Your Scrydex API key
  - `SCRYDEX_TEAM_ID`: spotlight
- **Resources:** 1GB RAM, 2 CPUs, 300s timeout, auto-scaling

## Architecture

### iOS App (`/Spotlight`)
- **Language:** Swift + SwiftUI
- **Deployment target:** iOS 18.0
- **Camera:** AVFoundation for live camera preview and capture
- **OCR:** Vision framework for card text recognition
- **Backend:** HTTP API calls to local Python server

### Backend (`/backend`)
- **Language:** Python
- **Server:** HTTP server on port 8788
- **Database:** SQLite (empty on startup, auto-populated on-demand)
- **Card Data:** Pokemon TCG API (20,237+ cards, fetched automatically)
- **Pricing:** Pokemon TCG API (includes TCGPlayer pricing)
- **Auto-import:** ALL cards fetched from Pokemon TCG API on first request
- **Caching:** 24-hour price cache for 75% cost reduction
- **Raw Scan Routing:** iPhone OCR sends raw scans directly to the backend for verification and pricing

### Key Files

**iOS:**
- `Spotlight/App/AppContainer.swift` - Dependency injection, backend URL configuration
- `Spotlight/Services/CameraSessionController.swift` - Camera session management
- `Spotlight/Services/CardRectangleAnalyzer.swift` - OCR configuration (bottom region scanning)
- `Spotlight/Services/ScanCacheManager.swift` - 7-day local price cache for offline fallback
- `Spotlight/ViewModels/ScannerViewModel.swift` - Scan flow (OCR → backend)
- `Spotlight/Views/ScannerView.swift` - Main scanner UI with cache indicators
- `Spotlight/Models/ScannerAPIModels.swift` - Locale configuration (forced to en_US)

**Backend:**
- `backend/server.py` - Main HTTP server with auto-import on card requests
- `backend/price_cache.py` - 24-hour thread-safe price cache
- `backend/catalog/identifiers/pokemon_complete.json` - Historical catalog artifact, not a runtime dependency for the app

## Deployment Instructions

### Backend Setup
```bash
cd /Users/stephenchan/Code/spotlight/backend

# Start backend server (no checked-in backend catalog snapshot needed!)
python3 server.py --skip-seed --port 8788

# Verify backend is running
curl http://127.0.0.1:8788/api/v1/health

# Check price cache status
curl http://127.0.0.1:8788/api/v1/ops/cache-status

```

### iOS App Deployment
```bash
cd /Users/stephenchan/Code/spotlight

# Clean build
xcodebuild clean -scheme Spotlight

# Open in Xcode
open Spotlight.xcodeproj

# In Xcode:
# 1. Select "schan iphone" from device dropdown
# 2. Ensure iPhone is unlocked and connected via USB
# 3. Click Run (⌘R)
# 4. Watch Xcode console for 📷 [CAMERA] logs
```

### First Time Setup
1. Enable Developer Mode on iPhone:
   - Settings → Privacy & Security → Developer Mode → Enable → Restart
2. Trust computer:
   - Popup on iPhone: "Trust This Computer?" → Trust
3. Grant camera permission:
   - Popup on first launch: "Allow Camera?" → Allow
   - Or: Settings → Spotlight → Camera → Allow

## Known Working Configuration

### What SHOULD work:
- ✅ Backend running with 2020 cards + auto-import
- ✅ Memory management (downscaled images, 20 item limit)
- ✅ USD/TCGPlayer pricing (locale forced to en_US)
- ✅ OCR targeting bottom 6% of card for collector number
- ✅ Auto-accept best match (no confidence gating)
- ✅ Clean UI (no extra buttons, tap to scan)

### What's NOT working:
- ❌ Camera preview on physical iPhone (black screen)
- ❌ Deployment loses connection to device

## Debug Commands

### Check backend status
```bash
curl -s http://127.0.0.1:8788/api/v1/health | python3 -m json.tool
```

### Check Mac's local IP (for iPhone connectivity)
```bash
ifconfig en0 | grep 'inet ' | awk '{print $2}'
```

### Kill existing backend process
```bash
lsof -ti:8788 | xargs kill -9
```

### Check iOS device connection
```bash
xcrun xctrace list devices
```

## OCR Configuration

Bottom region scanning for card identifiers:
```swift
bottomLeftRegion: CGRect(x: 0.08, y: 0.93, width: 0.40, height: 0.06)
bottomRightRegion: CGRect(x: 0.52, y: 0.93, width: 0.40, height: 0.06)
```

Targets last 6% of card where collector numbers appear (e.g., "TG30/TG30").

## Troubleshooting

### Black camera screen
1. Check camera permission: Settings → Spotlight → Camera
2. Check Xcode console for `📷 [CAMERA]` logs
3. Look for authorization status (should be 3 = authorized)
4. Verify session configures and starts

### Memory crashes
1. Ensure debug mode is `.disabled` in AppContainer.swift
2. Check scan stack not exceeding 20 items
3. Verify images are downscaled (max 300px)

### Backend not reachable from iPhone
1. Verify backend is running: `curl http://127.0.0.1:8788/api/v1/health`
2. Check Mac's firewall isn't blocking port 8788
3. Ensure iPhone and Mac on same WiFi network
4. Verify backend URL in AppContainer.swift matches Mac's IP

### Xcode loses connection
1. Use good quality USB cable
2. Try different USB port
3. Keep iPhone unlocked during deployment
4. Unplug/replug cable if connection lost

## Active Development Plans

### Caching Implementation (In Progress)
See [CACHING_PLAN.md](CACHING_PLAN.md) for full details.

**Goal:** Enable offline/convention usage + reduce API costs by 75%

**Three-layer strategy:**
1. Backend 24-hour price cache (provider-agnostic)
2. iPhone 7-day local cache with offline fallback
3. Pre-load sets feature for conventions

**Implementation phases:**
- Phase 1: Backend cache (4-6 hours) - High priority
- Phase 2: iPhone cache (6-8 hours) - High priority
- Phase 3: Pre-load sets (6-8 hours) - Medium priority

### Google Cloud Run Deployment
See [DEPLOY.md](DEPLOY.md) for deployment guide.

**Status:** Ready to deploy
- Dockerfile created
- Deploy script ready (`backend/deploy.sh`)
- Comprehensive deployment docs

## Next Session Priorities

1. **Implement Backend Price Cache** - Reduces costs, improves performance
   - Add 24-hour caching layer
   - Works with all providers (Scrydex, PriceCharting, Pokemon TCG)
   - 75% reduction in API calls

2. **Implement iPhone Local Cache** - Convention-ready offline support
   - Cache scan results locally
   - Offline fallback logic
   - Cache age indicators in UI

3. **Deploy to Google Cloud Run** - Move from local to production
   - Run `backend/deploy.sh`
   - Update AppContainer.swift with Cloud Run URL
   - Test end-to-end

## Reference

Device: iPhone 14,5 (schan iphone)
iOS: 18.3.1
Xcode: 26.2
macOS: 15.6.1
