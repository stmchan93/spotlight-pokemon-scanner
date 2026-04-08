# 🚀 Deployment Checklist - Google Cloud Run

## Quick Summary
**Time:** 20 minutes
**Cost:** $0-5/month for 1000-2000 users
**Difficulty:** Easy (just copy/paste commands)

---

## Pre-Deployment (One-time setup)

### ☐ 1. Create Google Cloud Account
- Go to https://console.cloud.google.com
- Sign up (gets $300 free credit)
- Create project: "spotlight-scanner"

### ☐ 2. Install Google Cloud CLI
```bash
brew install google-cloud-sdk
```

### ☐ 3. Login
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

---

## Deployment (20 minutes)

### ☐ 4. Create Dockerfile
In `backend/Dockerfile`:
```dockerfile
FROM python:3.14-slim
WORKDIR /app
COPY . /app
ENV PORT=8080
CMD python server.py \
    --database-path data/imported_scanner.sqlite \
    --port ${PORT} \
    --host 0.0.0.0 \
    --skip-seed
```

### ☐ 5. Create .dockerignore
In `backend/.dockerignore`:
```
__pycache__
*.pyc
.git
```

### ☐ 6. Enable APIs
```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
```

### ☐ 7. Deploy
```bash
cd backend
gcloud run deploy spotlight-backend \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi
```

**You'll get a URL like:** `https://spotlight-backend-xxxxx-uc.a.run.app`

### ☐ 8. Test Backend
```bash
curl https://YOUR-URL-HERE/api/v1/health
```

Should return: `{"status": "ok", "catalogCount": 2020, ...}`

---

## Update iPhone App

### ☐ 9. Update Backend URL
In `Spotlight/App/AppContainer.swift`, change:
```swift
// OLD:
let remoteBaseURL = URL(string: "http://192.168.0.225:8788/")!

// NEW:
let remoteBaseURL = URL(string: "https://YOUR-CLOUD-RUN-URL/")!
```

### ☐ 10. Remove Local Network Permission (Optional)
In `Spotlight/Resources/Info.plist`, delete:
```xml
<key>NSLocalNetworkUsageDescription</key>
<string>...</string>
```

### ☐ 11. Build and Deploy to iPhone
```bash
xcodebuild -scheme Spotlight -destination "platform=iOS,name=schan iphone" build
```

### ☐ 12. Test End-to-End
Scan a card, check logs for:
```
✅ [HYBRID] Primary backend succeeded
```

---

## Done! 🎉

Your app is now live on Google Cloud Run!

**To update backend later:**
```bash
cd backend
gcloud run deploy spotlight-backend --source .
```

**To view logs:**
```bash
gcloud run logs tail spotlight-backend
```

**To check costs:**
Visit: https://console.cloud.google.com/billing

---

## If You Want Even Easier: Railway.app

Skip all of Google Cloud and do this instead:

1. Push `backend/` to GitHub
2. Go to https://railway.app
3. "New Project" → "Deploy from GitHub"
4. Select your repo
5. Get URL automatically
6. Update iPhone app with Railway URL

**Cost:** $5/month (simpler, slightly more expensive)
