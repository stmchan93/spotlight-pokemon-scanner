# Spotlight Card Scanner - Development Log

Last updated: 2026-04-04

## Current Status

iOS card scanning app with backend integration. Camera scanner for Pokémon trading cards with real-time pricing from TCGPlayer.

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

### UI Simplification
- Removed "Live Scan Stack" subtitle
- Changed to simple "Spotlight" title
- Removed all control buttons from scanner view (import, torch, flashlight)
- Added import button to top-right of main screen only
- Removed bottom circular scan button
- Simplified to: tap anywhere on screen to scan

### Scanner Fixes
- Fixed photo zoom out issue (changed preview from `.resizeAspectFill` to `.resizeAspect`)
- Fixed OCR region targeting (moved to y: 0.93, last 6% of card for identifier strip)
- Removed confidence gating - always accept best match
- Hidden confidence labels in UI

### Backend Configuration
- Backend URL: `http://192.168.0.225:8788/` (Mac's local IP)
- Changed from localhost for iPhone connectivity
- Forced locale to `en_US` for TCGPlayer/USD pricing (not CardMarket/EUR)
- Backend must be running: `python3 backend/server.py --cards-file backend/catalog/pokemontcg/cards.json --database-path backend/data/imported_scanner.sqlite --port 8788`

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
- **Database:** SQLite with 2020+ Pokémon cards
- **Pricing:** Pokemon TCG API (includes TCGPlayer pricing)
- **Auto-import:** Missing cards fetched from Pokemon TCG API automatically

### Key Files

**iOS:**
- `Spotlight/App/AppContainer.swift` - Dependency injection, backend URL configuration
- `Spotlight/Services/CameraSessionController.swift` - Camera session management
- `Spotlight/Services/CardRectangleAnalyzer.swift` - OCR configuration (bottom region scanning)
- `Spotlight/ViewModels/ScannerViewModel.swift` - Scan flow, memory management
- `Spotlight/Views/ScannerView.swift` - Main scanner UI
- `Spotlight/Models/ScannerAPIModels.swift` - Locale configuration (forced to en_US)

**Backend:**
- `backend/server.py` - Main HTTP server
- `backend/data/imported_scanner.sqlite` - Card database (309 MB, 2020 cards)
- `backend/catalog/pokemontcg/cards.json` - Card catalog (7.9 MB)

## Deployment Instructions

### Backend Setup
```bash
cd /Users/stephenchan/Code/spotlight/backend

# Start backend server
python3 server.py \
  --cards-file catalog/pokemontcg/cards.json \
  --database-path data/imported_scanner.sqlite \
  --port 8788

# Verify backend is running
curl http://127.0.0.1:8788/api/v1/health
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

## Next Session Priorities

1. **FIX CAMERA BLACK SCREEN** - Critical blocker
   - Get camera logs from successful deployment
   - Identify where authorization/configuration fails
   - May need to investigate immediate crash on launch

2. Test end-to-end scanning once camera works

3. Verify backend connectivity from iPhone

4. Test memory stability with multiple scans

## Reference

Device: iPhone 14,5 (schan iphone)
iOS: 18.3.1
Xcode: 26.2
macOS: 15.6.1
