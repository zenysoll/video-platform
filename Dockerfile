# video-platform GPU worker image
#
# Pre-bakes: CUDA 12.8, PyTorch cu128 (sm_120 / RTX 5090 Blackwell), ComfyUI,
# ComfyUI-LTXVideo, ComfyUI-VideoHelperSuite, awscli, hf_transfer.
#
# Does NOT include model weights — those are downloaded at boot from R2 by
# src/worker/bootstrap-models.sh. Cold start ~5 min vs ~20 min for the old
# pytorch/pytorch + full-bootstrap path.
#
# Built and pushed by .github/workflows/build-worker-image.yml to
# ghcr.io/zenysoll/comfyui-ltx:cu128. ghcr.io public pulls are unmetered —
# Docker Hub's anonymous per-IP rate limit is what wedged instances on
# multi-tenant Vast hosts (see WORKER_IMAGE in src/queues/stream-consumer.ts).

FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1

# ── System packages ───────────────────────────────────────────────────────────
# Uses the distro python (3.10 on jammy) deliberately. The previous version
# installed python3.11 and pointed `python` at it, but `python3-pip` on jammy belongs
# to 3.10 — so every pip install landed in 3.10's site-packages while `python` was
# 3.11, and torch was missing at runtime. One interpreter, one pip, no split.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        python3 python3-dev python3-pip \
        git wget curl ffmpeg \
        libgl1 libglib2.0-0 libsm6 libxext6 \
        unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

# Every install below goes through `python -m pip` so it cannot drift to a different
# interpreter than the one that will actually run ComfyUI.
RUN python -m pip install --upgrade pip

# ── HuggingFace + AWS CLI (bootstrap-models.sh uses `aws s3 cp` against R2) ───
RUN python -m pip install huggingface_hub hf_transfer awscli requests

# ── ComfyUI + custom nodes ────────────────────────────────────────────────────
# Installed BEFORE torch on purpose: these requirements.txt files list a bare
# `torch`, so pip happily resolves the default CPU-only wheel from PyPI. Doing
# them first means the cu128 install below is the last word on which torch wins.
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI /workspace/ComfyUI && \
    python -m pip install -r /workspace/ComfyUI/requirements.txt

RUN git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo \
        /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo && \
    python -m pip install -r /workspace/ComfyUI/custom_nodes/ComfyUI-LTXVideo/requirements.txt

RUN git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite \
        /workspace/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite && \
    python -m pip install -r /workspace/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt \
        2>/dev/null || true

# ── PyTorch cu128 — required for RTX 5090 (Blackwell / sm_120) ────────────────
# STABLE cu128, not nightly: `pip install --pre --upgrade` against the nightly
# index silently no-ops when a cu126 build is already installed, leaving a torch
# that reports cuda.is_available() == True but ships no sm_120 kernels — a false
# positive that only surfaces as "no kernel image is available" at first render.
# --force-reinstall makes cu128 authoritative over whatever ComfyUI resolved above.
RUN python -m pip install --force-reinstall \
    torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cu128

# ── Model directories (weights downloaded at boot from R2) ───────────────────
RUN mkdir -p \
    /workspace/ComfyUI/models/checkpoints \
    /workspace/ComfyUI/models/text_encoders \
    /workspace/ComfyUI/output

WORKDIR /workspace

# Hard build-time gate on the WHEEL BUILD, not the arch list.
#
# torch.cuda.get_arch_list() returns [] in a CPU-only builder — it needs an
# initialised CUDA runtime, so it cannot verify anything here. What is verifiable
# without a GPU is which wheel actually survived the install, and that is the real
# risk this guards: ComfyUI's requirements.txt lists a bare `torch` and will happily
# leave a CPU or cu126 build in place. sm_120 itself is asserted at runtime, on the
# rented GPU, by bootstrap-models.sh.
RUN python -c "\
import torch; \
print('torch', torch.__version__, 'cuda', torch.version.cuda); \
assert torch.version.cuda == '12.8', f'expected CUDA 12.8 build, got {torch.version.cuda}'; \
assert '+cu128' in torch.__version__, f'expected a +cu128 wheel, got {torch.__version__}'"
