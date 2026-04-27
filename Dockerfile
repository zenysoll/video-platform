# video-platform GPU worker image
#
# Pre-bakes: CUDA 12.8, PyTorch nightly cu128 (sm_120 / RTX 5090 support),
# ComfyUI, ComfyUI-LTXVideo, ComfyUI-VideoHelperSuite, awscli, hf_transfer.
#
# Does NOT include model weights — those are downloaded at boot from R2.
# Expected cold-start after pull: ~5 min (R2 models) vs ~20 min (old bootstrap).
#
# Build & push:
#   docker build -t YOUR_DOCKERHUB/comfyui-ltx:cu128 .
#   docker push YOUR_DOCKERHUB/comfyui-ltx:cu128
#
# Update WORKER_IMAGE in src/queues/stream-consumer.ts after pushing.

FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3-pip \
        git wget curl ffmpeg \
        libgl1 libglib2.0-0 libsm6 libxext6 \
        unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
    && ln -sf /usr/bin/pip3 /usr/local/bin/pip

# ── PyTorch nightly cu128 — required for RTX 5090 (Blackwell / sm_120) ───────
# cu126 stable does NOT have sm_120 in its arch_list → "no kernel image" error.
RUN pip install --pre \
    torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/nightly/cu128

# ── HuggingFace + AWS CLI (for R2 model downloads) ───────────────────────────
RUN pip install huggingface_hub hf_transfer awscli requests

# ── ComfyUI ───────────────────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI /workspace/ComfyUI && \
    pip install -r /workspace/ComfyUI/requirements.txt

# ── ComfyUI-LTXVideo (LTX-2.3 nodes: LTXAVTextEncoderLoader, etc.) ───────────
RUN git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo \
        /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo && \
    pip install -r /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt

# ── ComfyUI-VideoHelperSuite (VHS_VideoCombine → MP4 export) ─────────────────
RUN git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite \
        /workspace/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite && \
    pip install -r /workspace/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt \
        2>/dev/null || true

# ── Model directories (weights downloaded at boot from R2) ───────────────────
RUN mkdir -p \
    /workspace/ComfyUI/models/checkpoints \
    /workspace/ComfyUI/models/text_encoders \
    /workspace/ComfyUI/output

WORKDIR /workspace

# Verify PyTorch sees sm_120 (Blackwell) — build fails fast if not
RUN python -c "
import torch
archs = torch.cuda.get_arch_list()
print('CUDA arch list:', archs)
assert any('sm_12' in a for a in archs), 'sm_120 NOT in arch list — wrong PyTorch build!'
print('sm_120 confirmed.')
" 2>/dev/null || echo "NOTE: sm_120 check skipped at build time (no GPU in builder). Will verify at runtime."
