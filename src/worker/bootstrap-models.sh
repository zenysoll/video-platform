#!/usr/bin/env bash
# GPU Worker bootstrap — MODEL-ONLY version for pre-built Docker image.
#
# Runs on instances using the custom comfyui-ltx:cu128 image where
# PyTorch, ComfyUI, and all Python deps are already installed.
#
# This script only:
#   1. Downloads the per-mode model set from R2 (or HF fallback):
#      flex/max — LTX-2.3 checkpoint + Gemma FP4
#      max2     — Wan 2.2 dual-expert set (2× 14B fp8 + UMT5 + VAE + loras)
#   2. Downloads worker.py + workflow.json from control plane
#   3. Starts ComfyUI + worker
#   4. Sends done signal when finished
#
# Expected boot time: ~5-7 min (R2) vs ~20 min (full bootstrap).
#
# Environment variables injected by the control plane:
#   CONTROL_PLANE_URL, STREAM_ID, WORKER_SECRET, TOTAL_VIDEOS
#   MODE — 'flex' (distilled ckpt), 'max' (22B dev ckpt + workflow-max), or
#          'max2' (Wan 2.2 set + workflow-wan);
#          defaults to flex so instances started by an older control plane boot fine
#   R2_MODEL_KEY_ID, R2_MODEL_SECRET — Cloudflare R2 credentials
#   HF_TOKEN — HuggingFace token (fallback if R2 empty)

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export HF_HUB_ENABLE_HF_TRANSFER=1

LOG() { echo "[bootstrap] $(date -u +%H:%M:%S) $*"; }

MODE="${MODE:-flex}"

LOG "Starting model-only bootstrap for stream ${STREAM_ID:-MISSING} (mode=${MODE})"

# ── Paths ─────────────────────────────────────────────────────────────────────
COMFY_DIR=/workspace/ComfyUI
MODEL_DIR="$COMFY_DIR/models"
R2_BUCKET="video-platform-models"
R2_ENDPOINT="https://95db7e4a7e28c95dfabfc52650591059.r2.cloudflarestorage.com"

mkdir -p "$MODEL_DIR/checkpoints" "$MODEL_DIR/text_encoders" \
         "$MODEL_DIR/diffusion_models" "$MODEL_DIR/vae" "$MODEL_DIR/loras"

# Instance id for the provision-failed signal. $CONTAINER_ID is what Vast actually
# sets at runtime; /etc/vast_instance_id does not exist (that assumption is what let
# instances leak and bill forever).
INSTANCE_ID="${CONTAINER_ID:-$(cat /etc/vast_instance_id 2>/dev/null || echo 0)}"

# ── CUDA gate ─────────────────────────────────────────────────────────────────
# Runs BEFORE the 55 GB model download so a bad host costs seconds, not 20 minutes.
#
# The image is built with a verified +cu128 wheel, but the arch list can only be
# checked where a GPU exists — get_arch_list() is empty in a CPU builder, so this
# check cannot live in the Dockerfile. It matters because torch.cuda.is_available()
# is a FALSE POSITIVE on Blackwell with a wrong-CUDA build: it returns True while the
# GPU's sm_NN kernels are missing, and inference only dies later with 'no kernel image'.
if ! python3 -c "
import torch, os, sys
gpu_count = int(os.environ.get('GPU_COUNT', '1'))
if not torch.cuda.is_available():
    print('CUDA not available'); sys.exit(1)
visible = torch.cuda.device_count()
if visible < gpu_count:
    print(f'Only {visible} GPU(s) visible, need {gpu_count}'); sys.exit(1)
cap = torch.cuda.get_device_capability(0)
cap_str = f'sm_{cap[0]}{cap[1]}'
arch_list = torch.cuda.get_arch_list()
if cap_str not in arch_list:
    print(f'{cap_str} not in torch arch list {arch_list}'); sys.exit(1)
" 2>/dev/null; then
  LOG "FATAL: CUDA check failed (unavailable, too few GPUs, or torch missing sm_NN kernels for this GPU)."
  nvidia-smi 2>&1 | head -5 || true
  python3 -c "import torch; print('torch:', torch.__version__, 'cuda:', torch.cuda.is_available(), 'arch_list:', torch.cuda.get_arch_list())" 2>&1 || true
  LOG "Sending provision-failed signal — reaper will bench this host and retry elsewhere."
  curl -sf -X POST "${CONTROL_PLANE_URL}/worker/streams/${STREAM_ID}/provision-failed" \
    -H "Authorization: Bearer ${WORKER_SECRET}" \
    -H "Content-Type: application/json" \
    -d "{\"instance_id\": ${INSTANCE_ID}, \"reason\": \"CUDA check failed on prebuilt image\"}" || true
  exit 0  # clean exit — do NOT send done (that would mark the stream completed)
fi
LOG "CUDA OK — $(python3 -c 'import torch; print(f"{torch.cuda.device_count()} device(s), cu{torch.version.cuda} on {torch.cuda.get_device_name(0)}")')"

# ── R2 download helper ────────────────────────────────────────────────────────
r2_cp() {
  # $1 = R2 key, $2 = local dest
  AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET" \
  aws s3 cp "s3://${R2_BUCKET}/$1" "$2" \
    --endpoint-url "$R2_ENDPOINT" --no-progress 2>&1
}

r2_cp_bucket() {
  # $1 = bucket, $2 = R2 key, $3 = local dest — same creds/endpoint, other bucket.
  AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET" \
  aws s3 cp "s3://$1/$2" "$3" \
    --endpoint-url "$R2_ENDPOINT" --no-progress 2>&1
}

r2_available() {
  [ -n "${R2_MODEL_KEY_ID:-}" ] && [ -n "${R2_MODEL_SECRET:-}" ]
}

# ── Generic model fetch: R2 first, HF fallback, min-size gate ─────────────────
# Same download discipline as the hand-rolled LTX/Gemma paths below, factored
# out because max2 needs it for seven files. The R2 key always mirrors the
# local path under models/ — one naming scheme, replayable from either source.
#   $1 = path relative to $MODEL_DIR (doubles as the R2 key)
#   $2 = HF repo id            $3 = file path inside the HF repo
#   $4 = minimum byte size (truncation gate)
fetch_model() {
  local rel="$1" repo="$2" hf_path="$3" min="$4"
  local dest="$MODEL_DIR/$rel"
  local name
  name="$(basename "$rel")"

  if [ -f "$dest" ] && [ "$(stat -c%s "$dest" 2>/dev/null || echo 0)" -ge "$min" ]; then
    LOG "$name already present."
    return 0
  fi

  LOG "Downloading $name..."
  local hf_dl
  hf_dl() {
    python3 -c "
import os, time, shutil
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '1'
from huggingface_hub import hf_hub_download
t0 = time.time()
path = hf_hub_download('$repo', '$hf_path', local_dir='/tmp/model_dl')
shutil.move(path, '$dest')
print(f'[bootstrap] $name done in {(time.time()-t0)/60:.1f}min', flush=True)
" 2>&1
  }
  size_ok() { [ "$(stat -c%s "$dest" 2>/dev/null || echo 0)" -ge "$min" ]; }

  if [ "$MODE" != "flex" ]; then
    # HuggingFace FIRST for the Wan set. Measured live 2026-07-23: HF Xet moves at
    # ~500 MB/s, while R2 (even the ENAM bucket) delivered ~17 MB/s to the rented
    # host — a 28 GB expert pair is ~1 min on HF vs ~30 min on R2. The earlier
    # "ENAM-first" order was a mis-measure and stalled a live 4-GPU boot; R2 is now
    # strictly the fallback if HF is unavailable.
    hf_dl || true
    if ! size_ok && r2_available; then
      LOG "HF failed for $name — trying ENAM R2..."
      r2_cp_bucket "video-platform-models-enam" "$rel" "$dest" || true
    fi
    if ! size_ok && r2_available; then
      LOG "ENAM failed for $name — trying APAC R2..."
      r2_cp "$rel" "$dest" || true
    fi
  else
    # flex (LTX): APAC R2 first (proven fast for this bucket), HF fallback.
    if ! (r2_available && r2_cp "$rel" "$dest"); then
      LOG "R2 miss for $name — HuggingFace fallback..."
      hf_dl || true
    fi
  fi

  size_ok || { LOG "ERROR: $name download incomplete"; exit 1; }
  LOG "$name ready."
}

# ── Wan 2.2 model manifest (max) — ~38 GB total ───────────────────────────────
# Fields: local-rel-path (= R2 key) | HF repo | HF file path | min bytes.
# The lightx2v 4-step v1.1 t2v lora pair comes from the Comfy-Org repackage —
# same weights as lightx2v/Wan2.2-Lightning's Seko-V1.1 pair, but published
# under stable descriptive filenames (the upstream repo only has per-version
# folders of generically named high/low_noise_model.safetensors).
# instareal_wan22_low.safetensors is Instara's Instareal_low.safetensors,
# renamed locally to a self-describing name the workflow references.
WAN_MANIFEST=(
  "diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors|Comfy-Org/Wan_2.2_ComfyUI_Repackaged|split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors|13000000000"
  "diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors|Comfy-Org/Wan_2.2_ComfyUI_Repackaged|split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors|13000000000"
  "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors|Comfy-Org/Wan_2.2_ComfyUI_Repackaged|split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors|6000000000"
  "vae/wan_2.1_vae.safetensors|Comfy-Org/Wan_2.2_ComfyUI_Repackaged|split_files/vae/wan_2.1_vae.safetensors|200000000"
  "loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors|Comfy-Org/Wan_2.2_ComfyUI_Repackaged|split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors|300000000"
  "loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors|Comfy-Org/Wan_2.2_ComfyUI_Repackaged|split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors|300000000"
  "loras/instareal_wan22_low.safetensors|Instara/instareal-wan-2.2|Instareal_low.safetensors|300000000"
)

# max2 is the legacy env value a pre-collapse instance may still carry.
if [ "$MODE" = "max" ] || [ "$MODE" = "max2" ]; then
  # ── Wan 2.2 dual-expert set — max downloads NO LTX and NO Gemma ─────────────
  for entry in "${WAN_MANIFEST[@]}"; do
    IFS='|' read -r rel repo hf_path min <<< "$entry"
    fetch_model "$rel" "$repo" "$hf_path" "$min"
  done
else

# ── LTX-2.3 distilled checkpoint (flex, ~46 GB) ──────────────────────────────
# The LTX-dev tier is gone (operator verdict 2026-07-23) — flex is the only LTX
# mode left. Min-size gate catches truncated downloads.
LTX_FILE="ltx-2.3-22b-distilled-1.1.safetensors"
LTX_MIN=40000000000
LTX_CKPT="$MODEL_DIR/checkpoints/$LTX_FILE"

if [ -f "$LTX_CKPT" ] && [ "$(stat -c%s "$LTX_CKPT" 2>/dev/null || echo 0)" -ge $LTX_MIN ]; then
  LOG "LTX-2.3 checkpoint already present."
else
  LOG "Downloading LTX-2.3 ($LTX_FILE)..."
  LTX_OK=false

  if r2_available; then
    if r2_cp "checkpoints/$LTX_FILE" "$LTX_CKPT"; then
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
hf_hub_download('Lightricks/LTX-2.3', '$LTX_FILE',
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

fi  # end per-mode model set (max2 = Wan, flex/max = LTX + Gemma)

LOG "Model download complete. Disk: $(df -h / | awk 'NR==2{print $3" used, "$4" free"}')"

# ── Seed R2 with models in background (only if downloaded from HF) ────────────
if r2_available; then
  (
    export AWS_ACCESS_KEY_ID="$R2_MODEL_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$R2_MODEL_SECRET"
    if [ "$MODE" = "max" ] || [ "$MODE" = "max2" ]; then
      # Seed the ENAM bucket (US, near our hosts), NOT the APAC one: measured
      # 65 MB/s from APAC vs ~500 MB/s from HF — an APAC copy would only create
      # a slow path the R2-first ordering then prefers. ENAM is the bucket the
      # max fetch path tries first. If the instance's R2 token turns out to be
      # scoped to the old bucket, every upload logs FAILED (non-fatal) and the
      # operator needs a one-time account-scoped token instead.
      ENAM_BUCKET="video-platform-models-enam"
      for entry in "${WAN_MANIFEST[@]}"; do
        IFS='|' read -r rel repo hf_path min <<< "$entry"
        WAN_R2_SIZE=$(aws s3 ls "s3://${ENAM_BUCKET}/$rel" \
          --endpoint-url "$R2_ENDPOINT" 2>/dev/null | awk '{print $3}' || echo 0)
        if [ "${WAN_R2_SIZE:-0}" -lt "$min" ]; then
          LOG "R2 upload: seeding $rel to ENAM..."
          aws s3 cp "$MODEL_DIR/$rel" "s3://${ENAM_BUCKET}/$rel" \
            --endpoint-url "$R2_ENDPOINT" --no-progress \
            && LOG "R2 upload: $rel done (ENAM)." || LOG "R2 upload: $rel FAILED (non-fatal)"
        fi
      done
    else
      # Only upload if not already in R2 (check size)
      LTX_R2_SIZE=$(aws s3 ls "s3://${R2_BUCKET}/checkpoints/$LTX_FILE" \
        --endpoint-url "$R2_ENDPOINT" 2>/dev/null | awk '{print $3}' || echo 0)
      if [ "${LTX_R2_SIZE:-0}" -lt $LTX_MIN ]; then
        LOG "R2 upload: seeding LTX-2.3 checkpoint ($LTX_FILE)..."
        aws s3 cp "$LTX_CKPT" "s3://${R2_BUCKET}/checkpoints/$LTX_FILE" \
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
    fi  # end per-mode seeding
  ) >> /tmp/r2_seed.log 2>&1 &
  LOG "R2 seed running in background (PID $!)"
fi

# ── Download worker scripts from control plane ────────────────────────────────
# The mode query selects the workflow variant (flex → workflow.json graph,
# max → workflow-max.json: dev ckpt, 24 steps, CFG 3.5, real negative prompt,
# max2 → workflow-wan.json: Wan 2.2 dual-expert graph).
LOG "Downloading worker scripts..."
wget -q -O /workspace/worker.py   "${CONTROL_PLANE_URL}/worker/worker.py"
wget -q -O /workspace/workflow.json "${CONTROL_PLANE_URL}/worker/workflow.json?mode=${MODE}"

# ── Multi-GPU setup ───────────────────────────────────────────────────────────
GPU_COUNT="${GPU_COUNT:-1}"
LOG "GPU_COUNT=${GPU_COUNT}"

# ── RIFE node fallback install (until the image bakes it) ─────────────────────
if [ "$MODE" != "flex" ] && [ ! -d /workspace/ComfyUI/custom_nodes/ComfyUI-Frame-Interpolation ]; then
  LOG "Installing ComfyUI-Frame-Interpolation (RIFE)..."
  git clone -q --depth 1 https://github.com/Fannovel16/ComfyUI-Frame-Interpolation     /workspace/ComfyUI/custom_nodes/ComfyUI-Frame-Interpolation     && (cd /workspace/ComfyUI/custom_nodes/ComfyUI-Frame-Interpolation && python install.py > /tmp/rife_install.log 2>&1)     && LOG "RIFE installed." || LOG "RIFE install FAILED — max renders will fail validation"
fi

# ── Start ComfyUI instances (one per GPU) ──────────────────────────────────────
# --lowvram is for flex only: 46 GB model on a 32 GB RTX 5090 needs layer
# streaming. Max runs a 42 GB model on a 96 GB RTX PRO 6000, and max2 runs two
# 14 GB fp8 Wan experts SEQUENTIALLY on a 32 GB RTX 5090 — each fits VRAM
# whole. Forcing LOW_VRAM on either would stream layers needlessly and
# multiply render time.
VRAM_FLAG="--lowvram"
[ "${MODE:-flex}" != "flex" ] && VRAM_FLAG=""
LOG "Starting ${GPU_COUNT}× ComfyUI (mode=${MODE:-flex}, vram flag='${VRAM_FLAG}')..."
cd "$COMFY_DIR"

for i in $(seq 0 $((GPU_COUNT - 1))); do
  PORT=$((8188 + i))
  LOG "Starting ComfyUI #${i} on port ${PORT} (CUDA_VISIBLE_DEVICES=${i})..."
  CUDA_VISIBLE_DEVICES=$i python main.py \
    --listen 127.0.0.1 --port $PORT \
    --disable-auto-launch $VRAM_FLAG \
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
curl -sf -X POST "${CONTROL_PLANE_URL}/worker/streams/${STREAM_ID}/done" \
  -H "Authorization: Bearer ${WORKER_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"instance_id\": ${INSTANCE_ID}}" || true

# Kill all ComfyUI instances
for i in $(seq 0 $((GPU_COUNT - 1))); do
  kill "$(cat /tmp/comfy_${i}.pid 2>/dev/null)" 2>/dev/null || true
done
LOG "Bootstrap complete."
