# Production Deployment Plan - Google Cloud Run

## Why Cloud Run?
- **Cost**: Free tier covers 2M requests/month (you'd use ~15k/month)
- **Scale**: 1000-2000 users = $0-5/month
- **Ease**: No server management, auto-scaling
- **Speed**: Deploy in ~15 minutes

## Prerequisites

### 1. Google Cloud Account Setup
- [ ] Create Google Cloud account at https://console.cloud.google.com
- [ ] Enable $300 free credit (lasts 90 days)
- [ ] Create new project: "spotlight-scanner" or similar
- [ ] Enable billing (won't charge until free credit exhausted)

### 2. Install Google Cloud CLI
```bash
# macOS
brew install google-cloud-sdk

# Or download from: https://cloud.google.com/sdk/docs/install
```

### 3. Authenticate
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

## Deployment Steps

### Phase 1: Prepare Backend for Cloud

#### Task 1.1: Create Dockerfile
Create `backend/Dockerfile`:
```dockerfile
FROM python:3.14-slim
WORKDIR /app
COPY . /app

ENV PORT=8080
CMD python server.py \
    --database-path data/spotlight_scanner.sqlite \
    --port ${PORT} \
    --host 0.0.0.0 \
    --skip-seed
```

#### Task 1.2: Create .dockerignore
Create `backend/.dockerignore`:
```
__pycache__
*.pyc
.git
.DS_Store
*.log
```

#### Task 1.3: Test Locally with Docker (Optional)
```bash
cd backend
docker build -t spotlight-backend .
docker run -p 8080:8080 spotlight-backend
# Test: curl http://localhost:8080/api/v1/health
```

### Phase 2: Deploy to Cloud Run

#### Task 2.1: Enable Required APIs
```bash
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

#### Task 2.2: Deploy Backend
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

**Output:** You'll get a URL like: `https://spotlight-backend-xxxxx-uc.a.run.app`

#### Task 2.3: Test Deployment
```bash
# Replace with your actual URL
curl https://spotlight-backend-xxxxx-uc.a.run.app/api/v1/health
```

Expected response:
```json
{
  "status": "ok",
  "catalogCount": 2020,
  ...
}
```

### Phase 3: Update iPhone App

#### Task 3.1: Update Backend URL in AppContainer.swift
Replace:
```swift
let remoteBaseURL = URL(string: "http://192.168.0.225:8788/")!
```

With:
```swift
let remoteBaseURL = URL(string: "https://spotlight-backend-xxxxx-uc.a.run.app/")!
```

#### Task 3.2: Remove Local Network Permission
Since you're using HTTPS to cloud, you don't need local network permission anymore!

In `Spotlight/Resources/Info.plist`, you can remove:
```xml
<key>NSLocalNetworkUsageDescription</key>
<string>...</string>
```

#### Task 3.3: Build and Test
```bash
xcodebuild -scheme Spotlight -destination "platform=iOS,name=schan iphone" build
```

Scan a card - should now see:
```
✅ [HYBRID] Primary backend succeeded
```

## Database Migration (When Ready)

### Current: SQLite (resets on redeploy)
- Works fine for testing
- Catalog data reloads from JSON on each deploy
- Scan history is lost on redeploy

### Future: Cloud SQL PostgreSQL (persistent)
When you need persistent data:

#### Task 4.1: Create Cloud SQL Instance
```bash
gcloud sql instances create spotlight-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1
```
**Cost:** ~$10/month for smallest instance

#### Task 4.2: Migrate Schema
Convert `backend/schema.sql` from SQLite to PostgreSQL syntax

#### Task 4.3: Update Backend Code
Change database connection from SQLite to PostgreSQL using environment variables

## Cost Breakdown

### Free Tier (Likely covers you):
- Cloud Run: 2M requests/month free
- Cloud Build: 120 build-minutes/day free
- Network: 1GB North America egress/month free

### Estimated Monthly Cost (1000-2000 users):
```
Requests: 15,000/month × $0.40/M requests = $0.006
CPU time: ~30 seconds/request × 15k = 125 hours
         125 vCPU-hours × $0.00002400/sec = ~$10.80
Memory: 512MB × 125 hours × $0.00000250/sec = ~$1.12

Total: ~$12/month (but likely covered by free tier)
```

### With PostgreSQL (optional):
```
Cloud SQL: $10/month (db-f1-micro)
Total: ~$22/month
```

## Monitoring & Maintenance

### View Logs
```bash
gcloud run logs tail spotlight-backend --project=YOUR_PROJECT
```

### View Metrics
```bash
# Opens Cloud Console
gcloud run services describe spotlight-backend --platform managed --region us-central1
```

### Update Backend
```bash
# Make changes to code
cd backend
gcloud run deploy spotlight-backend --source .
# Takes ~3-5 minutes, zero downtime
```

## Scaling Considerations

### Current Setup Handles:
- 1000-2000 users: ✅
- ~15k requests/month: ✅
- Concurrent users: Up to 10 instances (80+ concurrent)

### If You Grow Beyond:
```bash
# Increase max instances
gcloud run services update spotlight-backend --max-instances 50

# Increase memory/CPU
gcloud run services update spotlight-backend --memory 1Gi --cpu 2
```

## Rollback Plan

If deployment fails:
```bash
# List revisions
gcloud run revisions list --service spotlight-backend

# Rollback to previous
gcloud run services update-traffic spotlight-backend \
  --to-revisions REVISION_NAME=100
```

## Security Checklist

- [ ] Enable Cloud Armor (DDoS protection) if needed
- [ ] Set up API keys for pricing providers (TCGPlayer, etc.)
- [ ] Use Secret Manager for API keys (don't hardcode)
- [ ] Enable HTTPS only (Cloud Run does this by default)
- [ ] Monitor Cloud Run metrics for abuse

## Next Steps

1. **Now:** Keep using local backend with local fallback
2. **When ready to deploy:**
   - Follow Phase 1 (Prepare Backend) - 10 min
   - Follow Phase 2 (Deploy) - 5 min
   - Follow Phase 3 (Update App) - 5 min
3. **When you have consistent users:**
   - Migrate to Cloud SQL for persistence
   - Set up monitoring alerts
   - Optimize pricing API caching

## Estimated Time to Production

- **First deployment:** 20 minutes
- **Subsequent updates:** 3-5 minutes
- **Zero downtime:** Cloud Run handles gracefully

## Alternative: Railway.app (Even Easier)

If Google Cloud feels too complex:

1. Push `backend/` to GitHub
2. Connect Railway to GitHub repo
3. Click deploy
4. Get URL: `https://your-app.railway.app`
5. Update iPhone app

**Railway Pros:**
- Easier than Cloud Run
- $5/month flat fee
- Auto-deploys on git push

**Railway Cons:**
- More expensive at scale
- Less configuration options

Choose Railway if: You want simplest possible
Choose Cloud Run if: You want cheapest + most scalable
