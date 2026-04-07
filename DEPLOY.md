# 🚀 Google Cloud Run Deployment Guide

Deploy the Spotlight backend to Google Cloud Run in 20 minutes.

## Prerequisites

### 1. Google Cloud Account
- Create account at https://console.cloud.google.com
- Get $300 free credit (90 days)
- Create project: "spotlight-scanner" (or any name)
- Enable billing (won't charge until free credit exhausted)

### 2. Install Google Cloud CLI

**macOS:**
```bash
brew install google-cloud-sdk
```

**Windows/Linux:**
Download from https://cloud.google.com/sdk/docs/install

### 3. Authenticate

```bash
# Login to Google Cloud
gcloud auth login

# Set your project ID (replace with your actual project ID)
gcloud config set project spotlight-scanner

# Verify setup
gcloud config list
```

## Quick Deploy (Automated)

The easiest way to deploy:

```bash
cd backend
./deploy.sh
```

This script will:
- ✅ Check if gcloud is installed and authenticated
- ✅ Enable required APIs
- ✅ Build and deploy your backend
- ✅ Show you the service URL

**Estimated time:** 5-7 minutes

## Manual Deploy (Step-by-Step)

If you prefer manual control:

### Step 1: Enable Required APIs
```bash
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

### Step 2: Deploy Backend
```bash
cd backend

gcloud run deploy spotlight-backend \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 10
```

**Wait 5-7 minutes** for the build and deployment.

You'll get output like:
```
Service [spotlight-backend] revision [spotlight-backend-00001] has been deployed
Service URL: https://spotlight-backend-xxxxx-uc.a.run.app
```

### Step 3: Test Deployment

```bash
# Replace with your actual URL
curl https://spotlight-backend-xxxxx-uc.a.run.app/api/v1/health
```

Expected response:
```json
{
  "status": "ok",
  "catalogCount": 2020,
  "version": "...",
  "providers": {...}
}
```

## Update iPhone App

### Step 1: Update Backend URL

Edit `Spotlight/App/AppContainer.swift`:

```swift
// BEFORE:
let remoteBaseURL = URL(string: "http://192.168.0.225:8788/")!

// AFTER (replace with your actual Cloud Run URL):
let remoteBaseURL = URL(string: "https://spotlight-backend-xxxxx-uc.a.run.app/")!
```

### Step 2: Build and Test

```bash
# Build for simulator
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -sdk iphonesimulator build

# Or build for device
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -destination "name=schan iphone" build
```

### Step 3: Verify

Run the app and scan a card. Check Xcode console for:
```
✅ [HYBRID] Primary backend succeeded
```

## Common Issues

### Issue: "Permission denied" when running deploy.sh
```bash
chmod +x backend/deploy.sh
```

### Issue: "Project not set"
```bash
gcloud config set project YOUR_PROJECT_ID
```

### Issue: "gcloud: command not found"
```bash
# macOS
brew install google-cloud-sdk

# Then restart your terminal
```

### Issue: Build fails with "No space left on device"
This is a Cloud Build issue. Try:
```bash
gcloud builds list --limit=10
gcloud builds cancel BUILD_ID  # Cancel any stuck builds
```

### Issue: "The user does not have permission to access project"
```bash
gcloud auth login
# Make sure you're using the correct Google account
```

## Monitoring

### View Logs
```bash
gcloud run logs tail spotlight-backend --project=YOUR_PROJECT_ID
```

### View Service Details
```bash
gcloud run services describe spotlight-backend \
  --platform managed \
  --region us-central1
```

### View in Console
```bash
# Opens Cloud Console in browser
open "https://console.cloud.google.com/run?project=YOUR_PROJECT_ID"
```

## Updating the Backend

After making code changes:

```bash
cd backend
./deploy.sh
```

Or manually:
```bash
cd backend
gcloud run deploy spotlight-backend --source .
```

**Deployment time:** 3-5 minutes
**Downtime:** Zero (Cloud Run handles gracefully)

## Cost Estimates

### Free Tier (likely covers your usage):
- **Requests:** 2M/month free
- **CPU:** 180,000 vCPU-seconds/month free
- **Memory:** 360,000 GiB-seconds/month free
- **Network:** 1GB North America egress/month free

### Estimated Cost for 1000-2000 users (~15k requests/month):
```
Requests: 15,000 × $0.40/M = $0.006/month
CPU: ~30s/request × 15k = 450k seconds
     450k × $0.00002400 = $10.80/month
Memory: 512MB × 125 hours × $0.00000250 = $1.12/month

Total: ~$12/month (likely covered by free tier = $0)
```

## Scaling

Current configuration handles:
- ✅ Up to 10 concurrent instances
- ✅ ~80+ concurrent users
- ✅ 15k-30k requests/month

### To increase capacity:
```bash
# Increase max instances
gcloud run services update spotlight-backend --max-instances 50

# Increase memory/CPU
gcloud run services update spotlight-backend --memory 1Gi --cpu 2
```

## Rollback

If something goes wrong:

```bash
# List revisions
gcloud run revisions list --service spotlight-backend

# Rollback to previous revision
gcloud run services update-traffic spotlight-backend \
  --to-revisions REVISION_NAME=100
```

## Security

✅ **HTTPS Only** - Cloud Run enforces HTTPS
✅ **IAM Authentication** - Can enable if needed
✅ **DDoS Protection** - Cloud Armor available
✅ **Secret Management** - Use Secret Manager for API keys

### To add authentication (optional):
```bash
# Remove --allow-unauthenticated from deploy command
# Then only authenticated requests will work
```

## Alternative: Railway.app

If Google Cloud feels too complex:

1. Push `backend/` to GitHub
2. Go to https://railway.app
3. "New Project" → "Deploy from GitHub"
4. Select your repo
5. Railway auto-detects Dockerfile and deploys
6. Get URL: `https://your-app.railway.app`
7. Update iPhone app

**Pros:** Simpler, auto-deploys on git push
**Cons:** $5-20/month (vs $0-12 on Cloud Run)

## Troubleshooting

### Deployment hangs at "Building..."
This is normal - first build takes 5-7 minutes

### 502 Bad Gateway after deployment
Wait 30 seconds - service is still starting

### App shows "Backend unavailable"
1. Check URL is correct in AppContainer.swift
2. Test health endpoint: `curl YOUR_URL/api/v1/health`
3. Check logs: `gcloud run logs tail spotlight-backend`

## Next Steps

After successful deployment:

1. ✅ App is live on Cloud Run
2. 📱 iPhone app connects to cloud backend
3. 💰 Free tier likely covers your usage
4. 📊 Monitor via Cloud Console
5. 🔄 Update with `./deploy.sh`

### Future Enhancements:
- [ ] Migrate to Cloud SQL for persistent database
- [ ] Set up monitoring alerts
- [ ] Configure custom domain
- [ ] Enable Cloud Armor for DDoS protection
- [ ] Set up automated backups

## Support

- **Cloud Run docs:** https://cloud.google.com/run/docs
- **Pricing calculator:** https://cloud.google.com/products/calculator
- **Support:** https://cloud.google.com/support

---

**Estimated time to production:** 20 minutes
**Estimated monthly cost:** $0-12 (likely $0 with free tier)
