#!/bin/bash
# חותמטק: פריסת שירות הניתוח. מריצים מהתיקייה הזו אחרי `gcloud auth login`.
# דרישות חד-פעמיות בפרויקט: חיוב מופעל, והרצת ההכנה למטה.
set -euo pipefail

PROJECT="migdalor-501804"
REGION="me-west1"                       # ישראל
BUCKET="hotamtech-analysis-tmp"         # GCS זמני לאודיו
ENV_FILE=".env.deploy.yaml"             # נוצר ידנית, לא נכנס לגיט

if [ ! -f "$ENV_FILE" ]; then
  echo "חסר $ENV_FILE. צור אותו במבנה:"
  echo "  SUPABASE_URL: \"https://ndrhiikczkbosentclnh.supabase.co\""
  echo "  SUPABASE_ANON: \"<anon>\""
  echo "  SUPABASE_SERVICE_KEY: \"<service_role>\""
  echo "  ANTHROPIC_API_KEY: \"<key>\""
  echo "  WORKER_URL: \"https://migdalor.nirbosco-com-yotzer-education.workers.dev\""
  echo "  GCS_TEMP_BUCKET: \"$BUCKET\""
  exit 1
fi

# הכנה חד-פעמית (בטוח להריץ שוב):
gcloud services enable speech.googleapis.com cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com run.googleapis.com storage.googleapis.com \
  --project "$PROJECT"
gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" \
  --location "$REGION" --uniform-bucket-level-access 2>/dev/null || true
# מחיקה אוטומטית של קבצים זמניים אחרי יום
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}' > /tmp/lc.json
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=/tmp/lc.json --project "$PROJECT"

gcloud functions deploy hotamtech-analyze \
  --gen2 --project "$PROJECT" --region "$REGION" \
  --runtime nodejs20 --entry-point analyze --trigger-http \
  --allow-unauthenticated \
  --memory 2GiB --timeout 3600s --max-instances 3 \
  --env-vars-file "$ENV_FILE" \
  --source .

echo "כתובת השירות:"
gcloud functions describe hotamtech-analyze --gen2 --project "$PROJECT" \
  --region "$REGION" --format='value(serviceConfig.uri)'
