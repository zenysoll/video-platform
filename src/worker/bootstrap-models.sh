#!/usr/bin/env bash
# GPU Worker bootstrap — MODEL-ONLY version for pre-built Docker image.
#
# Runs on instances using the custom comfyui-ltx:cu128 image where
# PyTorch, ComfyUI, and all Python deps are already installed.
#
# This script only:
#   1. Downloads LTX-2.3 checkpoint + Gemma FP4 from R2 (or HF fallback)
#   2. Downloads worker.py + workflow.json from control plane
#   3. Starts ComfyUI + worker
#   4. Sends done signal when finished
#
# Expected boot time: ~5-7 min (R2) vs ~20 min (full bootstrap).
#
# Environment variables injected by the control plane:
#   CONTROL_PLANE_URL, STREAM_ID, WORKER_SECRET, TOTAL_VIDEOS
#   R2_MODEL_KEY_ID, R2_MODEL_SECRET — Cloudflare R2 credentials
#   HF_TOKEN — HuggingFace token (fallback if R2 empty)

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export HF_HUB_ENABLE_HF_TRANSFER=1

LOG() { echo "[bootstrap] $(date -u +%H:%M:%S) $*"; }

LOG "Starting model-only bootstrap for stream ${STREAM_ID:-MISSING}"

# ── Paths ─────────────────────────────────────────────────────────────────────
COMFY_DIR=/workspace/ComfyUI
MODEL_DIR="$COMFY_DIR/models"
R2_BUCKET="video-platform-models"
R2_ENDPOINT="https://95db7e4a7e28c95dfabfc52650591059.r2.cloudflarestorage.com"

mkdir -p "$MODEL_DIR/checkpoints" "$MODEL_DIR/text_encoders"

# ── R2 download helper ────────────────────────────────────────────────────────
r2_cp() {
  # $1 = R2 key, $2 = local dest
  AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET" \
  aws s3 cp "s3://${R2_BUCKET}/$1" "$2" \
    --endpoint-url "$R2_ENDPOINT" --no-progress 2>&1
}

r2_available() {
  [ -n "${R2_MODEL_KEY_ID:-}" ] && [ -n "${R2_MODEL_SECRET:-}" ]
}

# ── LTX-2.3 distilled v1.1 — 46 GB ──────────────────────────────────────────
LTX_CKPT="$MODEL_DIR/checkpoints/ltx-2.3-22b-distilled-1.1.safetensors"
LTX_MIN=40000000000

if [ -f "$LTX_CKPT" ] && [ "$(stat -c%s "$LTX_CKPT" 2>/dev/null || echo 0)" -ge $LTX_MIN ]; then
  LOG "LTX-2.3 checkpoint already present."
else
  LOG "Downloading LTX-2.3 (~46 GB)..."
  LTX_OK=false

  if r2_available; then
    if r2_cp "checkpoints/ltx-2.3-22b-distilled-1.1.safetensors" "$LTX_CKPT"; then
      LTX_OK=true
      LOG "LTX-2.3 downloaded from R2."
    else
      LOG "R2 download failed — falling back to HuggingFace..."
    fi
  fi

  if [ "$LTX_OK" = false ]; then
    python3 -c "
import os, time
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'
from huggingface_hub import hf_hub_download
t0 = time.time()
hf_hub_download('Lightricks/LTX-2.3', 'ltx-2.3-22b-distilled-1.1.safetensors',
    local_dir='$MODEL_DIR/checkpoints')
print(f'[bootstrap] LTX done in {(time.time()-t0)/60:.1f}min', flush=True)
"
  fi

  [ "$(stat -c%s "$LTX_CKPT" 2>/dev/null || echo 0)" -ge $LTX_MIN ] || \
    { LOG "ERROR: LTX-2.3 download incomplete"; exit 1; }
  LOG "LTX-2.3 ready."
fi

# ── Gemma-3 12B FP4 — 8.8 GB ─────────────────────────────────────────────────
GEMMA="$MODEL_DIR/text_encoders/comfy_gemma_3_12B_it.safetensors"
GEMMA_MIN=8000000000

if [ -f "$GEMMA" ] && [ "$(stat -c%s "$GEMMA" 2>/dev/null || echo 0)" -ge $GEMMA_MIN ]; then
  LOG "Gemma FP4 already present."
else
  LOG "Downloading Gemma-3 FP4 (~8.8 GB)..."
  GEMMA_OK=false

  if r2_available; then
    if r2_cp "text_encoders/comfy_gemma_3_12B_it.safetensors" "$GEMMA"; then
      GEMMA_OK=true
      LOG "Gemma FP4 downloaded from R2."
    else
      LOG "R2 download failed — falling back to HuggingFace..."
    fi
  fi

  if [ "$GEMMA_OK" = false ]; then
    python3 -c "
import os, time, shutil
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'
from huggingface_hub import hf_hub_download
t0 = time.time()
path = hf_hub_download('Comfy-Org/ltx-2',
    'split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors',
    local_dir='/tmp/gemma_dl')
shutil.move(path, '$GEMMA')
print(f'[bootstrap] Gemma done in {(time.time()-t0)/60:.1f}min', flush=True)
"
  fi

  [ "$(stat -c%s "$GEMMA" 2>/dev/null || echo 0)" -ge $GEMMA_MIN ] || \
    { LOG "ERROR: Gemma FP4 download incomplete"; exit 1; }
  LOG "Gemma FP4 ready."
fi

LOG "Model download complete. Disk: $(df -h / | awk 'NR==2{print $3" used, "$4" free"}')"

# ── Seed R2 with models in background (only if downloaded from HF) ────────────
if r2_available; then
  (
    export AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET"
    # Only upload if not already in R2 (check size)
    LTX_R2_SIZE=$(aws s3 ls "s3://${R2_BUCKET}/checkpoints/ltx-2.3-22b-distilled-1.1.safetensors" \
      --endpoint-url "$R2_ENDPOINT" 2>/dev/null | awk '{print $3}' || echo 0)
    if [ "${LTX_R2_SIZE:-0}" -lt 40000000000 ]; then
      LOG "R2 upload: seeding LTX-2.3 checkpoint..."
      aws s3 cp "$LTX_CKPT" "s3://${R2_BUCKET}/checkpoints/ltx-2.3-22b-distilled-1.1.safetensors" \
        --endpoint-url "$R2_ENDPOINT" --no-progress \
        && LOG "R2 upload: LTX-2.3 done." || LOG "R2 upload: LTX-2.3 FAILED (non-fatal)"
    fi
    GEMMA_R2_SIZE=$(aws s3 ls "s3://${R2_BUCKET}/text_encoders/comfy_gemma_3_12B_it.safetensors" \
      --endpoint-url "$R2_ENDPOINT" 2>/dev/null | awk '{print $3}' || echo 0)
    if [ "${GEMMA_R2_SIZE:-0}" -lt 8000000000 ]; then
      LOG "R2 upload: seeding Gemma FP4..."
      aws s3 cp "$GEMMA" "s3://${R2_BUCKET}/text_encoders/comfy_gemma_3_12B_it.safetensors" \
        --endpoint-url "$R2_ENDPOINT" --no-progress \
        && LOG "R2 upload: Gemma done." || LOG "R2 upload: Gemma FAILED (non-fatal)"
    fi
  ) >> /tmp/r2_seed.log 2>&1 &
  LOG "R2 seed running in background (PID $!)"
fi

# ── Download worker scripts from control plane ────────────────────────────────
LOG "Downloading worker scripts..."
wget -q -O /workspace/worker.py   "${CONTROL_PLANE_URL}/worker/worker.py"
wget -q -O /workspace/workflow.json "${CONTROL_PLANE_URL}/worker/workflow.json"

# ── Multi-GPU setup ───────────────────────────────────────────────────────────
GPU_COUNT="${GPU_COUNT:-1}"
LOG "GPU_COUNT=${GPU_COUNT}"

# ── Start ComfyUI instances (one per GPU) ──────────────────────────────────────
LOG "Starting ${GPU_COUNT}× ComfyUI (--lowvram for 46 GB model on 32 GB GPU)..."
cd "$COMFY_DIR"

for i in $(seq 0 $((GPU_COUNT - 1))); do
  PORT=$((8188 + i))
  LOG "Starting ComfyUI #${i} on port ${PORT} (CUDA_VISIBLE_DEVICES=${i})..."
  CUDA_VISIBLE_DEVICES=$i python main.py \
    --listen 127.0.0.1 --port $PORT \
    --disable-auto-launch --lowvram \
    > /tmp/comfy_${i}.log 2>&1 &
  echo $! > /tmp/comfy_${i}.pid
done

# ── Wait for all ComfyUI instances to become ready ────────────────────────────
for i in $(seq 0 $((GPU_COUNT - 1))); do
  PORT=$((8188 + i))
  LOG "Waiting for ComfyUI #${i} (port ${PORT})..."
  READY=false
  for tick in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then
      LOG "ComfyUI #${i} ready after $((tick * 5))s"
      READY=true
      break
    fi
    sleep 5
  done
  if [ "$READY" = false ]; then
    LOG "ERROR: ComfyUI #${i} failed to start. Last 30 lines:"
    tail -30 /tmp/comfy_${i}.log
    exit 1
  fi
done

# ── Run N parallel job workers (each on its own ComfyUI port) ─────────────────
LOG "Starting ${GPU_COUNT} parallel worker(s)..."
for i in $(seq 0 $((GPU_COUNT - 1))); do
  PORT=$((8188 + i))
  LOG "Starting worker #${i} → COMFY_URL=http://127.0.0.1:${PORT}"
  COMFY_URL="http://127.0.0.1:${PORT}" python /workspace/worker.py \
    >> /tmp/worker_${i}.log 2>&1 &
  echo $! > /tmp/worker_${i}.pid
done

# ── Wait for all workers to finish ────────────────────────────────────────────
LOG "Waiting for all workers to complete..."
wait 2>/dev/null || true
LOG "All workers finished."

# ── Done signal → control plane destroys instance ─────────────────────────────
LOG "Sending done signal..."
INSTANCE_ID="${CONTAINER_ID:-$(cat /etc/vast_instance_id 2>/dev/null || echo 0)}"
curl -sf -X POST "${CONTROL_PLANE_URL}/worker/streams/${STREAM_ID}/done" \
  -H "Authorization: Bearer ${WORKER_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"instance_id\": ${INSTANCE_ID}}" || true

# Kill all ComfyUI instances
for i in $(seq 0 $((GPU_COUNT - 1))); do
  kill "$(cat /tmp/comfy_${i}.pid 2>/dev/null)" 2>/dev/null || true
done
LOG "Bootstrap complete."
