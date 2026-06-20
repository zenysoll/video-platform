#!/usr/bin/env bash
# GPU Worker bootstrap script for LTX-Video 2.3 via ComfyUI.
# Runs on a fresh Vast.ai instance after startup.
#
# Environment variables injected by the control plane:
#   CONTROL_PLANE_URL, STREAM_ID, WORKER_SECRET, TOTAL_VIDEOS
#   HF_TOKEN — HuggingFace access token for gated models (Gemma-3)

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

LOG() { echo "[bootstrap] $(date -u +%H:%M:%S) $*"; }

# ── Env diagnostics (non-fatal — runs before set -u can bite us) ──────────────
curl -sf --max-time 10 \
  "${CONTROL_PLANE_URL:-MISSING}/health?phase=bootstrap-start&stream=${STREAM_ID:-MISSING}&secret=${WORKER_SECRET:+SET}&hf_token=${HF_TOKEN:+SET}" \
  > /dev/null 2>&1 || echo "[bootstrap] WARNING: health ping failed (env vars may be missing)"

LOG "Starting bootstrap for stream ${STREAM_ID}"

# ── System deps ───────────────────────────────────────────────────────────────
# Use Check-Valid-Until=false to tolerate clock-skew on fresh Vast.ai instances
# (host NTP lag causes "Release file not valid yet" errors that break apt-get update).
# Also install openssh-client/server as a safety net: Vast.ai's own Docker build
# step installs openssh, but it fails when apt lists are stale (same clock-skew
# issue). Without openssh the /.launch SSH tunnel cannot start and the instance
# becomes unreachable. This re-install is a no-op if Vast.ai already installed it.
apt-get -o Acquire::Check-Valid-Until=false update -q || true
apt-get install -y -q openssh-client openssh-server git wget ffmpeg libgl1 libglib2.0-0
# If sshd was just installed, restart it so Vast.ai's /.launch tunnel can connect.
service ssh restart 2>/dev/null || true

# ── Python base deps ──────────────────────────────────────────────────────────
pip install -q --upgrade pip
# hf_transfer: Rust-based parallel HF downloader — saturates full bandwidth vs wget's ~11 MB/s
pip install -q requests huggingface_hub hf_transfer

# ── ComfyUI ───────────────────────────────────────────────────────────────────
COMFY_DIR=/workspace/ComfyUI

if [ ! -d "$COMFY_DIR" ]; then
  LOG "Cloning ComfyUI..."
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI "$COMFY_DIR"
  # NOTE: requirements.txt contains bare `torch` which pip resolves to latest stable
  # (cu126). We will override with nightly cu128 AFTER all requirements are installed.
  pip install -q -r "$COMFY_DIR/requirements.txt"
fi

# ── ComfyUI-LTXVideo custom node (LTX-2.3 compatible) ────────────────────────
LTXV_NODE_DIR="$COMFY_DIR/custom_nodes/ComfyUI-LTXVideo"

if [ ! -d "$LTXV_NODE_DIR" ]; then
  LOG "Installing ComfyUI-LTXVideo node..."
  git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo "$LTXV_NODE_DIR"
  pip install -q -r "$LTXV_NODE_DIR/requirements.txt"
fi

# ── VideoHelperSuite for video export ─────────────────────────────────────────
VHS_NODE_DIR="$COMFY_DIR/custom_nodes/ComfyUI-VideoHelperSuite"

if [ ! -d "$VHS_NODE_DIR" ]; then
  LOG "Installing VideoHelperSuite..."
  git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite "$VHS_NODE_DIR"
  pip install -q -r "$VHS_NODE_DIR/requirements.txt" 2>/dev/null || true
fi

# ── CRITICAL: install PyTorch cu128 LAST — must run after all requirements ────
# The base image ships torch 2.6.0+cu126, and ComfyUI/LTXVideo requirements pin
# bare `torch` (stable cu126). cu126 has NO sm_120 kernels (RTX 5090 / Blackwell)
# → "no kernel image is available" at inference.
#
# Previously this used `--pre --upgrade ... nightly/cu128`, but `--upgrade` often
# found no newer version on the nightly index and SILENTLY kept 2.6.0+cu126 — the
# instance then passed the (too-lax) CUDA check and only died mid-render. Use a
# FORCE-REINSTALL from the STABLE cu128 channel (torch ≥2.7 ships sm_120) so the
# result is deterministic regardless of what the base image / requirements left.
LOG "Installing PyTorch cu128 (RTX 5090 / sm_120 required, force-reinstall)..."
pip install -q --force-reinstall \
  torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
LOG "PyTorch version: $(python3 -c 'import torch; print(torch.__version__)')"

# ── Verify CUDA is accessible (fast-fail before 55 GB model download) ─────────
LOG "Verifying CUDA access..."
INSTANCE_ID="${CONTAINER_ID:-$(cat /etc/vast_instance_id 2>/dev/null || echo 0)}"

if ! python3 -c "
import torch, sys, os
gpu_count = int(os.environ.get('GPU_COUNT', '1'))
if not torch.cuda.is_available():
    print('CUDA not available')
    sys.exit(1)
visible = torch.cuda.device_count()
if visible < gpu_count:
    print(f'Only {visible} GPU(s) visible, need {gpu_count}')
    sys.exit(1)
# torch.cuda.is_available() is a FALSE POSITIVE on Blackwell with a cu126 build:
# it returns True even when the GPU's sm_NN kernels are missing, so inference later
# dies with 'no kernel image'. Verify the device's compute capability is in the
# torch compiled arch list so a wrong-CUDA torch fails fast HERE, before the 55 GB
# model download and before any render is attempted.
cap = torch.cuda.get_device_capability(0)
cap_str = f'sm_{cap[0]}{cap[1]}'
arch_list = torch.cuda.get_arch_list()
if cap_str not in arch_list:
    print(f'{cap_str} not in torch arch list {arch_list}')
    sys.exit(1)
" 2>/dev/null; then
  LOG "FATAL: CUDA check failed (unavailable, too few GPUs, or torch missing sm_NN kernels for this GPU)."
  LOG "  nvidia-smi output:"
  nvidia-smi 2>&1 | head -5 || true
  LOG "  torch.cuda check:"
  python3 -c "import torch, os; print('torch:', torch.__version__, 'cuda:', torch.cuda.is_available(), 'devices:', torch.cuda.device_count(), 'cap:', torch.cuda.get_device_capability(0) if torch.cuda.is_available() else None, 'arch_list:', torch.cuda.get_arch_list())" 2>&1 || true
  LOG "Sending provision-failed signal — reaper will retry on a different host."
  curl -sf -X POST "${CONTROL_PLANE_URL}/worker/streams/${STREAM_ID}/provision-failed" \
    -H "Authorization: Bearer ${WORKER_SECRET}" \
    -H "Content-Type: application/json" \
    -d "{\"instance_id\": ${INSTANCE_ID}, \"reason\": \"CUDA check failed: not available or device_count < GPU_COUNT=${GPU_COUNT:-1}\"}" || true
  exit 0  # clean exit — do NOT send done signal (that would mark stream completed)
fi
LOG "CUDA OK — $(python3 -c 'import torch; print(f"{torch.cuda.device_count()} device(s), {torch.version.cuda} on {torch.cuda.get_device_name(0)}")')"

# ── Model directories ─────────────────────────────────────────────────────────
MODEL_DIR="$COMFY_DIR/models"
mkdir -p "$MODEL_DIR/checkpoints" "$MODEL_DIR/text_encoders"

# ── Model download helper ─────────────────────────────────────────────────────
# Fast path: R2 bucket (hundreds of MB/s, no rate limits).
# Slow path: HuggingFace via hf_transfer (~11 MB/s, CDN rate-limited).
# R2 credentials are set via Cloudflare Worker secrets:
#   R2_MODEL_KEY_ID, R2_MODEL_SECRET — R2 API token with Object Read on video-platform-models.
# Once credentials are available, run: ./upload_models_to_r2.sh on a live instance to populate.
R2_MODEL_BUCKET="video-platform-models"
R2_ENDPOINT="https://95db7e4a7e28c95dfabfc52650591059.r2.cloudflarestorage.com"

download_from_r2_or_hf() {
  # $1 = destination path, $2 = R2 key, $3 = HF repo, $4 = HF filename, $5 = HF token (optional)
  local DEST="$1" R2_KEY="$2" HF_REPO="$3" HF_FILE="$4" HF_TOKEN_ARG="${5:-}"
  local R2_OK=false
  if [ -n "${R2_MODEL_KEY_ID:-}" ] && [ -n "${R2_MODEL_SECRET:-}" ]; then
    LOG "Downloading ${HF_FILE} from R2 (fast path)..."
    pip install -q awscli 2>/dev/null || true
    if AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID" \
       AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET" \
       aws s3 cp "s3://${R2_MODEL_BUCKET}/${R2_KEY}" "$DEST" \
         --endpoint-url "$R2_ENDPOINT" --no-progress 2>&1; then
      R2_OK=true
    else
      LOG "R2 download failed (not in bucket yet) — falling back to HuggingFace..."
    fi
  fi
  if [ "$R2_OK" = false ]; then
    LOG "Downloading ${HF_FILE} from HuggingFace (~11 MB/s)..."
    export HF_HUB_ENABLE_HF_TRANSFER=1
    python3 -c "
import os, time
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'
from huggingface_hub import hf_hub_download
t0 = time.time()
hf_hub_download(repo_id='$HF_REPO', filename='$HF_FILE',
    local_dir='$(dirname "$DEST")',
    token='$HF_TOKEN_ARG' if '$HF_TOKEN_ARG' else None)
print(f'[bootstrap] {\"$HF_FILE\"} done in {(time.time()-t0)/60:.1f}min', flush=True)
"
  fi
}

download_dir_from_r2_or_hf() {
  # $1 = destination dir, $2 = R2 prefix, $3 = HF repo, $4 = HF token
  local DEST="$1" R2_PREFIX="$2" HF_REPO="$3" HF_TOKEN_ARG="${4:-}"
  mkdir -p "$DEST"
  local R2_OK=false
  if [ -n "${R2_MODEL_KEY_ID:-}" ] && [ -n "${R2_MODEL_SECRET:-}" ]; then
    LOG "Syncing ${R2_PREFIX} from R2 (fast path)..."
    pip install -q awscli 2>/dev/null || true
    # Check if any objects exist in R2 prefix before syncing
    OBJ_COUNT=$(AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID" \
      AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET" \
      aws s3 ls "s3://${R2_MODEL_BUCKET}/${R2_PREFIX}/" \
        --endpoint-url "$R2_ENDPOINT" 2>/dev/null | wc -l || echo 0)
    if [ "$OBJ_COUNT" -gt 0 ]; then
      AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID" \
      AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET" \
      aws s3 sync "s3://${R2_MODEL_BUCKET}/${R2_PREFIX}/" "$DEST/" \
        --endpoint-url "$R2_ENDPOINT" --no-progress && R2_OK=true \
        || LOG "R2 sync failed — falling back to HuggingFace..."
    else
      LOG "R2 prefix ${R2_PREFIX} is empty — falling back to HuggingFace..."
    fi
  fi
  if [ "$R2_OK" = false ]; then
    LOG "R2 credentials not set — downloading ${HF_REPO} from HuggingFace..."
    export HF_HUB_ENABLE_HF_TRANSFER=1
    python3 -c "
import os, time
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'
from huggingface_hub import snapshot_download
t0 = time.time()
snapshot_download('$HF_REPO', local_dir='$DEST',
    token='$HF_TOKEN_ARG' if '$HF_TOKEN_ARG' else None,
    ignore_patterns=['*.bin', 'flax_*', 'tf_*', '*.gguf'])
print(f'[bootstrap] done in {(time.time()-t0)/60:.1f}min', flush=True)
"
  fi
}

# ── LTX-2.3 distilled v1.1 (public, no auth) — 46.1 GB bf16 ─────────────────
LTX_CKPT="$MODEL_DIR/checkpoints/ltx-2.3-22b-distilled-1.1.safetensors"
if [ ! -f "$LTX_CKPT" ] || [ "$(stat -c%s "$LTX_CKPT" 2>/dev/null || echo 0)" -lt 40000000000 ]; then
  pip install -q hf_transfer huggingface_hub
  download_from_r2_or_hf \
    "$LTX_CKPT" \
    "checkpoints/ltx-2.3-22b-distilled-1.1.safetensors" \
    "Lightricks/LTX-2.3" \
    "ltx-2.3-22b-distilled-1.1.safetensors"
  LOG "LTX-2.3 download complete."
fi

# ── Gemma-3 12B FP4 text encoder (public, no auth) — 8.8 GB ──────────────────
# Using ComfyUI-native FP4 quantized format (Comfy-Org/ltx-2) with
# LTXAVTextEncoderLoader node. Replaces the old 24 GB BF16 multi-shard version
# (google/gemma-3-12b-it-qat) which caused OOM on 32 GB VRAM with LTX-2.3 22B.
GEMMA_FP4="$MODEL_DIR/text_encoders/comfy_gemma_3_12B_it.safetensors"
GEMMA_FP4_MIN_SIZE=8000000000
if [ -f "$GEMMA_FP4" ] && [ "$(stat -c%s "$GEMMA_FP4" 2>/dev/null || echo 0)" -ge $GEMMA_FP4_MIN_SIZE ]; then
  LOG "Gemma-3 FP4 already present ($(du -sh "$GEMMA_FP4" | cut -f1))."
else
  LOG "Downloading Gemma-3 12B FP4 (~8.8 GB) from Comfy-Org/ltx-2..."
  pip install -q hf_transfer huggingface_hub

  # Fast path: R2 bucket — file stored at key text_encoders/comfy_gemma_3_12B_it.safetensors
  GEMMA_R2_OK=false
  if [ -n "${R2_MODEL_KEY_ID:-}" ] && [ -n "${R2_MODEL_SECRET:-}" ]; then
    pip install -q awscli 2>/dev/null || true
    if AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID" \
       AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET" \
       aws s3 cp "s3://${R2_MODEL_BUCKET}/text_encoders/comfy_gemma_3_12B_it.safetensors" \
         "$GEMMA_FP4" --endpoint-url "$R2_ENDPOINT" --no-progress 2>&1; then
      GEMMA_R2_OK=true
      LOG "Gemma-3 FP4 downloaded from R2."
    else
      LOG "R2 not populated yet — falling back to HuggingFace..."
    fi
  fi

  # Slow path: HuggingFace. The HF path has subdirs (split_files/text_encoders/),
  # so we download to a temp dir then rename to the expected path.
  if [ "$GEMMA_R2_OK" = false ]; then
    export HF_HUB_ENABLE_HF_TRANSFER=1
    python3 -c "
import os, time, shutil
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'
from huggingface_hub import hf_hub_download
t0 = time.time()
path = hf_hub_download(
    repo_id='Comfy-Org/ltx-2',
    filename='split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors',
    local_dir='/tmp/gemma_fp4_dl')
dest = '$GEMMA_FP4'
shutil.move(path, dest)
print(f'[bootstrap] Gemma FP4 done in {(time.time()-t0)/60:.1f}min -> {dest}', flush=True)
"
  fi

  if [ ! -f "$GEMMA_FP4" ] || [ "$(stat -c%s "$GEMMA_FP4" 2>/dev/null || echo 0)" -lt $GEMMA_FP4_MIN_SIZE ]; then
    LOG "ERROR: Gemma-3 FP4 download incomplete or corrupted — aborting."
    exit 1
  fi
  LOG "Gemma-3 FP4 download complete ($(du -sh "$GEMMA_FP4" | cut -f1))."
fi

# ── Download worker script + workflow from control plane ──────────────────────
LOG "Downloading worker scripts..."
wget -q -O /workspace/worker.py   "${CONTROL_PLANE_URL}/worker/worker.py"
wget -q -O /workspace/workflow.json "${CONTROL_PLANE_URL}/worker/workflow.json"

# ── Multi-GPU setup ───────────────────────────────────────────────────────────
GPU_COUNT="${GPU_COUNT:-1}"
LOG "GPU_COUNT=${GPU_COUNT}"

# ── Start ComfyUI instances (one per GPU) ─────────────────────────────────────
LOG "Starting ${GPU_COUNT}× ComfyUI..."
cd "$COMFY_DIR"
# --lowvram: offloads model layers to CPU RAM between inference steps.
# Required for LTX-2.3 22B (46 GB BF16) on 32 GB VRAM — without it the
# first job submission would OOM during model load.

for i in $(seq 0 $((GPU_COUNT - 1))); do
  PORT=$((8188 + i))
  LOG "Starting ComfyUI #${i} on port ${PORT} (CUDA_VISIBLE_DEVICES=${i})..."
  CUDA_VISIBLE_DEVICES=$i python main.py \
    --listen 127.0.0.1 --port $PORT \
    --disable-auto-launch --lowvram \
    > /tmp/comfy_${i}.log 2>&1 &
  echo $! > /tmp/comfy_${i}.pid
done

# Wait for all ComfyUI instances to become ready (up to 5 min each)
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
    LOG "ERROR: ComfyUI #${i} failed to start within 300s. Last 30 lines:"
    tail -30 /tmp/comfy_${i}.log
    LOG "Sending provision-failed signal — host may have broken GPU runtime."
    curl -sf -X POST "${CONTROL_PLANE_URL}/worker/streams/${STREAM_ID}/provision-failed" \
      -H "Authorization: Bearer ${WORKER_SECRET}" \
      -H "Content-Type: application/json" \
      -d "{\"instance_id\": ${INSTANCE_ID}, \"reason\": \"ComfyUI #${i} failed to start within 300s\"}" || true
    exit 0  # clean exit — do NOT send done signal
  fi
done

# ── Upload models to R2 in background (parallel with rendering) ───────────────
# This runs concurrently with the worker so future instance boots use R2 fast path.
if [ -n "${R2_MODEL_KEY_ID:-}" ] && [ -n "${R2_MODEL_SECRET:-}" ]; then
  LOG "Starting background R2 model upload..."
  pip install -q awscli 2>/dev/null || true
  (
    R2_ENDPOINT="https://95db7e4a7e28c95dfabfc52650591059.r2.cloudflarestorage.com"
    R2_BUCKET="video-platform-models"
    export AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET"

    LOG "R2 upload: LTX-2.3 checkpoint..."
    aws s3 cp "$LTX_CKPT" "s3://${R2_BUCKET}/checkpoints/ltx-2.3-22b-distilled-1.1.safetensors" \
      --endpoint-url "$R2_ENDPOINT" --no-progress \
      && LOG "R2 upload: LTX-2.3 done." \
      || LOG "R2 upload: LTX-2.3 FAILED (non-fatal)"

    LOG "R2 upload: Gemma-3 FP4..."
    aws s3 cp "$GEMMA_FP4" "s3://${R2_BUCKET}/text_encoders/comfy_gemma_3_12B_it.safetensors" \
      --endpoint-url "$R2_ENDPOINT" --no-progress \
      && LOG "R2 upload: Gemma-3 FP4 done." \
      || LOG "R2 upload: Gemma-3 FP4 FAILED (non-fatal)"
  ) >> /tmp/r2_upload.log 2>&1 &
  R2_UPLOAD_PID=$!
  LOG "R2 upload running in background (PID $R2_UPLOAD_PID)"
fi

# ── Run N parallel job workers (each on its own ComfyUI port) ─────────────────
LOG "Starting ${GPU_COUNT} parallel worker(s)..."
for i in $(seq 0 $((GPU_COUNT - 1))); do
  PORT=$((8188 + i))
  LOG "Starting worker #${i} → COMFY_URL=http://127.0.0.1:${PORT}"
  COMFY_URL="http://127.0.0.1:${PORT}" python /workspace/worker.py \
    >> /tmp/worker_${i}.log 2>&1 &
  echo $! > /tmp/worker_${i}.pid
done

# ── Wait for all workers and R2 upload ───────────────────────────────────────
LOG "Waiting for all workers to complete..."
wait 2>/dev/null || true
LOG "All workers finished."

# ── Done signal + cleanup ─────────────────────────────────────────────────────
LOG "Worker finished. Sending done signal to control plane."
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
