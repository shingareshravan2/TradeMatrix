# Deploying TradeMatrix to Google Cloud Run

The container is built to be Cloud Run–native:
- It listens on `$PORT` (Cloud Run sets it; defaults to `8080`).
- It reads `DATABENTO_API_KEY` from the environment. **The secret is never baked
  into the image.** Cloud Run injects it from Secret Manager at startup.
- One image serves both the FastAPI backend and the built React SPA, so a single
  Cloud Run service is everything you deploy.

The guide below is end-to-end. Copy/paste, replacing the placeholders at the top.

---

## 0. Set your variables

```bash
export PROJECT_ID=your-gcp-project-id
export REGION=us-central1            # any Cloud Run region
export REPO=tradematrix               # Artifact Registry repo name
export SERVICE=tradematrix            # Cloud Run service name
export SECRET=databento-api-key       # Secret Manager secret name
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:latest"
```

---

## 1. One-time GCP setup

Install the gcloud CLI (https://cloud.google.com/sdk/docs/install), then:

```bash
# Log in and select the project.
gcloud auth login
gcloud config set project "$PROJECT_ID"

# Enable the APIs you'll use.
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com

# Create the Artifact Registry Docker repo (one-time).
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="TradeMatrix container images"

# Let docker push to Artifact Registry.
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
```

---

## 2. Store the Databento key in Secret Manager

`gcloud secrets versions add` always takes the secret name and a path to a file
containing the raw value:

```
gcloud secrets versions add SECRET_NAME --data-file=PATH_TO_FILE
```

So the simple, shell-independent way:

```bash
# Create the secret resource (one-time, no value yet).
gcloud secrets create "$SECRET" --replication-policy=automatic

# Put the raw key value into a temp file (just the value — NO "DATABENTO_API_KEY="
# prefix, NO quotes, NO trailing newline).
echo -n "db-YOUR-ACTUAL-KEY-HERE" > /tmp/dbnto.key

# Add it as the first version of the secret.
gcloud secrets versions add "$SECRET" --data-file=/tmp/dbnto.key

# Wipe the temp file.
shred -u /tmp/dbnto.key   # or: rm /tmp/dbnto.key
```

To rotate the key later: write the new value to a fresh temp file and run the
same `versions add` again — Cloud Run will pick up `:latest` on the next
deploy/revision.

---

## 3. Build & push the image

Two options. The local Docker build is faster if you already have Docker
running; Cloud Build is one command and needs nothing local.

**Option A — local Docker:**

```bash
docker build -t "$IMAGE" .
docker push "$IMAGE"
```

**Option B — Cloud Build (no local Docker required):**

```bash
gcloud builds submit --tag "$IMAGE" .
```

---

## 4. Deploy to Cloud Run with the secret injected

```bash
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=1 \
  --max-instances=3 \
  --set-secrets="DATABENTO_API_KEY=${SECRET}:latest"
```

`--min-instances=1` keeps an instance available when the service is idle, avoiding
scale-to-zero shutdowns. This can incur ongoing Cloud Run charges. Cloud Run can
still restart instances for maintenance or failures.

What's happening:
- `--set-secrets` binds Secret Manager `databento-api-key:latest` to the
  container env var `DATABENTO_API_KEY`. The backend reads
  `os.environ["DATABENTO_API_KEY"]` and never sees the secret value any other way.
- `--port=8080` is just the *container* port; Cloud Run also sets `PORT=8080`
  which our `CMD` honours.
- `--allow-unauthenticated` makes it a public URL. Remove that if you want to
  require IAM auth.

The first deploy returns a URL like `https://tradematrix-xyz.a.run.app` — open
it in a browser, the SPA loads and the backend serves API/WS from the same
origin.

---

## 5. Grant the runtime service account access to the secret

On the **first** deploy Cloud Run may say it can't read the secret. Grant
permission once:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor"
```

Then re-run the `gcloud run deploy` from step 4.

---

## 6. Verify

```bash
URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
echo "$URL"

# SPA loads
curl -s -o /dev/null -w "GET /              -> %{http_code}\n" "$URL"

# API works (yfinance, hyperliquid, databento all listed)
curl -s "$URL/api/sources" | python3 -m json.tool | head

# Databento works (means the secret got injected and the source initialised)
curl -s "$URL/api/candles?source=databento&symbol=NQ.c.0&interval=1d&limit=3" | python3 -m json.tool
```

If the last call returns `[]`, tail the logs to see the real error:

```bash
gcloud run services logs read "$SERVICE" --region="$REGION" --limit=80
```

---

## 7. Re-deploys

Every code change is the same two steps:

```bash
docker build -t "$IMAGE" . && docker push "$IMAGE"       # or: gcloud builds submit --tag "$IMAGE" .
gcloud run deploy "$SERVICE" --image="$IMAGE" --region="$REGION"
```

You don't need to re-pass `--set-secrets` on re-deploys — the binding is on the
service, not the image. To **rotate** the Databento key, run `gcloud secrets
versions add` (step 2); the next revision picks up `:latest` automatically.

---

## What's where

| Concern | Where it lives | Notes |
|---|---|---|
| Container port | `Dockerfile` (`CMD … --port ${PORT:-8080}`) | Cloud Run sets `$PORT`. |
| Secret value | Secret Manager (`databento-api-key`) | Never in git, never in the image. |
| Secret → env binding | `gcloud run deploy --set-secrets …` | Lives on the Cloud Run service config. |
| Local dev secret | `.env` at the repo root (gitignored) | Read by `backend/run.sh`, used only on your machine. |
| Local Docker testing | `docker-compose.yml` | Has **no** secret references — by design. Export `DATABENTO_API_KEY` in your shell before `docker compose up` if you want it for local container testing. |
