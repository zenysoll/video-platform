#!/usr/bin/env python3
"""
GPU Worker — job polling loop for LTX-Video rendering via ComfyUI.

Environment variables (set by Vast.ai bootstrap):
  CONTROL_PLANE_URL   — base URL of the CF Worker
  STREAM_ID           — which stream to render
  WORKER_SECRET       — shared auth secret
  TOTAL_VIDEOS        — total videos expected (for progress logging)
  HF_TOKEN            — HuggingFace token (used only in bootstrap.sh, not here)
"""

import json
import math
import os
import random
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

CONTROL_PLANE_URL = os.environ["CONTROL_PLANE_URL"].rstrip("/")
STREAM_ID         = os.environ["STREAM_ID"]
WORKER_SECRET     = os.environ["WORKER_SECRET"]
TOTAL_VIDEOS      = int(os.environ.get("TOTAL_VIDEOS", "0"))
# Quality mode set by the control plane at provision time. Selects which workflow
# variant the control plane serves and which checkpoint bootstrap put on disk.
MODE              = os.environ.get("MODE", "flex")
# HF_TOKEN is used only by bootstrap.sh (model download), not needed here.

COMFY_URL         = os.getenv("COMFY_URL", "http://127.0.0.1:8188")
WORKFLOW_PATH     = "/workspace/workflow.json"
# ?mode= must ride along on every per-job re-fetch — without it a max instance
# would hot-update itself back onto the flex workflow mid-stream.
WORKFLOW_URL      = f"{CONTROL_PLANE_URL}/worker/workflow.json?mode={MODE}"
COMFY_OUTPUT_DIR  = "/workspace/ComfyUI/output"

POLL_INTERVAL_SEC = 10   # seconds between job claim attempts when queue is empty
# Give up after ~40 min of no jobs. Must exceed the reaper's batch-chain repair
# window (BATCH_CHAIN_STALL_MIN=30) so a transient Gemini stall that pauses prompt
# generation does NOT make the worker exit and trigger a full re-provision +
# re-download of the 55 GB model set. 240 × 10s = 40 min.
MAX_IDLE_POLLS    = 240

# ── Helpers ───────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    print(f"[worker] {time.strftime('%H:%M:%S')} {msg}", flush=True)


UA = "video-platform-worker/1.0"


def cp_request(method: str, path: str, body: dict | None = None) -> dict | None:
    """Call the control plane API."""
    url = f"{CONTROL_PLANE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bearer {WORKER_SECRET}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status == 204:
                return None
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")[:200]
        log(f"HTTP {e.code} on {method} {path}: {body_text}")
        raise


def claim_job() -> dict | None:
    """Claim next pending job. Returns job dict or None if no jobs available."""
    instance_id = read_instance_id()
    path = f"/worker/jobs/claim?stream_id={STREAM_ID}&instance_id={instance_id}"
    req = urllib.request.Request(
        f"{CONTROL_PLANE_URL}{path}",
        headers={"Authorization": f"Bearer {WORKER_SECRET}", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status == 204:
                return None
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 204:
            return None
        raise


def upload_video(job_id: str, video_path: str) -> str:
    """Upload rendered video to the control plane. Returns r2_key."""
    url = f"{CONTROL_PLANE_URL}/worker/videos/{job_id}"
    with open(video_path, "rb") as f:
        video_bytes = f.read()

    req = urllib.request.Request(
        url, data=video_bytes, method="POST",
        headers={
            "Authorization": f"Bearer {WORKER_SECRET}",
            "Content-Type": "video/mp4",
            "Content-Length": str(len(video_bytes)),
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
        return result["r2_key"]


def report_complete(job_id: str, r2_key: str) -> None:
    cp_request("POST", f"/worker/jobs/{job_id}/complete", {"r2_key": r2_key})


def report_fail(job_id: str, error: str) -> None:
    try:
        cp_request("POST", f"/worker/jobs/{job_id}/fail", {"error": error})
    except Exception as e:
        log(f"Failed to report job failure: {e}")


def read_instance_id() -> str:
    # Vast.ai exposes the instance id at runtime as $CONTAINER_ID. The old path
    # (/etc/vast_instance_id) does not exist on Vast hosts, so this used to always
    # return "unknown" — breaking per-worker job attribution (multi-GPU) and the
    # /done instance scoping. Prefer the env var, fall back to the (legacy) file.
    cid = os.environ.get("CONTAINER_ID")
    if cid:
        return cid.strip()
    try:
        return Path("/etc/vast_instance_id").read_text().strip()
    except Exception:
        return "unknown"


# ── ComfyUI integration ───────────────────────────────────────────────────────

def fetch_workflow() -> dict:
    """
    Fetch workflow.json fresh from the control plane before each job.
    Falls back to the locally cached file if the fetch fails.
    This allows hot-updating the workflow without restarting the instance.
    """
    try:
        req = urllib.request.Request(WORKFLOW_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            wf = json.loads(resp.read())
            # Cache the fresh copy locally for fallback.
            with open(WORKFLOW_PATH, "w") as f:
                json.dump(wf, f)
            return wf
    except Exception as e:
        log(f"Failed to fetch workflow from control plane ({e}), using cached copy")
        with open(WORKFLOW_PATH) as f:
            return json.load(f)


MAX_LTX_FRAMES = 257  # LTX-Video 2.3 hard limit: 8×32+1. Exceeding it produces black frames.

def frames_for_duration(fps: int, duration_secs: int) -> int:
    """
    LTX-Video requires num_frames = 8k + 1 (e.g. 25, 33, 41, ...).
    Compute the nearest valid value >= fps * duration_secs, capped at MAX_LTX_FRAMES.
    """
    target = fps * duration_secs
    # Find k such that 8k+1 >= target
    k = math.ceil((target - 1) / 8)
    frames = max(8 * k + 1, 9)  # minimum 9 frames
    if frames > MAX_LTX_FRAMES:
        # Clamp to largest valid value within model limit (8×32+1 = 257)
        k_max = (MAX_LTX_FRAMES - 1) // 8  # = 32
        frames = 8 * k_max + 1             # = 257
    return frames


# Must match the file bootstrap-models.sh downloaded for this MODE — the sound
# path below feeds it to LTXVAudioVAELoader, which reads from disk by filename.
LTX_CHECKPOINT = (
    "ltx-2.3-22b-dev.safetensors" if MODE == "max"
    else "ltx-2.3-22b-distilled-1.1.safetensors"
)


def build_workflow(job: dict) -> dict:
    wf = fetch_workflow()
    prompt        = job["prompt_text"]
    width         = int(job.get("width", 768))
    height        = int(job.get("height", 512))
    fps           = int(job.get("fps", 24))
    duration      = int(job.get("duration_secs", 5))
    seed          = random.randint(0, 2**32 - 1)
    nframes       = frames_for_duration(fps, duration)
    sound_enabled = bool(job.get("sound_enabled", False))

    replacements = {
        "__PROMPT__":     prompt,
        "__WIDTH__":      width,
        "__HEIGHT__":     height,
        "__NUM_FRAMES__": nframes,
        "__FPS__":        fps,
        "__SEED__":       seed,
    }

    # Deep-replace placeholders in workflow JSON.
    wf_str = json.dumps(wf)
    for k, v in replacements.items():
        wf_str = wf_str.replace(f'"{k}"', json.dumps(v))
    wf = json.loads(wf_str)

    if sound_enabled:
        # LTX-2.3 AV pipeline:
        # 14 = AudioVAELoader (uses same checkpoint as video model)
        # 15 = EmptyLatentAudio (empty audio latent matching video duration)
        # 16 = ConcatAVLatent  (combine video + audio latents for joint sampling)
        # 11 = SamplerCustomAdvanced — updated to use AV latent [16] instead of [6]
        # 17 = SeparateAVLatent (split sampled latent back into video + audio)
        # 12 = VAEDecode — updated to use video part [17, 0]
        # 18 = AudioVAEDecode (decode audio latent → waveform)
        # 13 = VHS_VideoCombine — updated to include audio [18]
        wf["14"] = {
            "class_type": "LTXVAudioVAELoader",
            "inputs": {"ckpt_name": LTX_CHECKPOINT},
        }
        wf["15"] = {
            "class_type": "LTXVEmptyLatentAudio",
            "inputs": {
                "frames_number": nframes,
                "frame_rate": fps,
                "batch_size": 1,
                "audio_vae": ["14", 0],
            },
        }
        wf["16"] = {
            "class_type": "LTXVConcatAVLatent",
            "inputs": {
                "video_latent": ["6", 0],
                "audio_latent": ["15", 0],
            },
        }
        # Route sampler through AV-concatenated latent instead of video-only latent.
        wf["11"]["inputs"]["latent_image"] = ["16", 0]

        wf["17"] = {
            "class_type": "LTXVSeparateAVLatent",
            "inputs": {"av_latent": ["11", 0]},
        }
        # VAEDecode now uses the video portion of the separated latent.
        wf["12"]["inputs"]["samples"] = ["17", 0]

        wf["18"] = {
            "class_type": "LTXVAudioVAEDecode",
            "inputs": {
                "samples": ["17", 1],
                "audio_vae": ["14", 0],
            },
        }
        # Pass decoded audio to the video combiner.
        wf["13"]["inputs"]["audio"] = ["18", 0]

    return wf


def submit_workflow(workflow: dict) -> str:
    """Submit workflow to ComfyUI. Returns prompt_id."""
    payload = json.dumps({"prompt": workflow, "client_id": "video-worker"}).encode()
    req = urllib.request.Request(
        f"{COMFY_URL}/prompt", data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
        if "prompt_id" not in result:
            # ComfyUI returns node validation errors as 200 OK with error dict
            errors = result.get("node_errors", result.get("error", result))
            raise RuntimeError(f"ComfyUI rejected workflow: {json.dumps(errors)[:500]}")
        return result["prompt_id"]


def wait_for_completion(prompt_id: str, timeout_sec: int = 600) -> dict:
    """Poll ComfyUI history until the prompt completes. Returns output info."""
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        req = urllib.request.Request(f"{COMFY_URL}/history/{prompt_id}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            history = json.loads(resp.read())

        if prompt_id in history:
            entry = history[prompt_id]
            status = entry.get("status", {})
            if status.get("completed"):
                return entry.get("outputs", {})
            if status.get("status_str") in ("error", "interrupted"):
                raise RuntimeError(f"ComfyUI render failed: {status}")

        time.sleep(3)

    raise TimeoutError(f"ComfyUI render timed out after {timeout_sec}s")


def find_output_video(outputs: dict) -> str | None:
    """Extract the video file path from ComfyUI outputs."""
    for node_outputs in outputs.values():
        for key in ("gifs", "videos"):
            files = node_outputs.get(key, [])
            for f in files:
                filename = f.get("filename")
                subfolder = f.get("subfolder", "")
                if filename:
                    path = Path(COMFY_OUTPUT_DIR) / subfolder / filename
                    if path.exists():
                        return str(path)
    return None


# ── ComfyUI readiness check ───────────────────────────────────────────────────

def wait_for_comfyui(timeout_sec: int = 600, poll_sec: int = 5) -> None:
    """
    Block until ComfyUI is ready to accept prompts.

    ComfyUI loads the LTX-2.3 model (46 GB) into VRAM on first startup —
    this takes 2-5 minutes on RTX 5090.  The /queue endpoint returns 200
    only after model loading is complete; submitting a prompt before that
    causes a write-timeout because ComfyUI accepts the TCP connection but
    stalls while still loading.

    We poll GET /queue (lightweight, no side-effects) until it succeeds,
    then do one final check on /system_stats to confirm CUDA is available.
    """
    deadline = time.time() + timeout_sec
    log("Waiting for ComfyUI to be ready (model loading into VRAM)...")
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        try:
            req = urllib.request.Request(f"{COMFY_URL}/queue")
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    log(f"ComfyUI ready after {attempt} polls (~{attempt * poll_sec}s wait)")
                    return
        except Exception as e:
            if attempt % 6 == 1:  # log every 30s
                log(f"ComfyUI not ready yet ({e}), retrying...")
        time.sleep(poll_sec)
    raise RuntimeError(f"ComfyUI did not become ready within {timeout_sec}s")


# ── ComfyUI node diagnostic reporter ─────────────────────────────────────────

def report_comfy_nodes() -> None:
    """
    Query ComfyUI /object_info and POST the full node catalogue to the control plane.
    Called once after ComfyUI becomes ready so we can see all available nodes,
    especially LTX-AV audio nodes, without needing SSH access.
    """
    try:
        req = urllib.request.Request(f"{COMFY_URL}/object_info")
        with urllib.request.urlopen(req, timeout=30) as resp:
            info = json.loads(resp.read())

        # Collect every node and its input parameter names.
        all_nodes: dict = {}
        for node_name, node_def in info.items():
            inputs_required = list((node_def.get("input") or {}).get("required", {}).keys())
            inputs_optional = list((node_def.get("input") or {}).get("optional", {}).keys())
            all_nodes[node_name] = {
                "required": inputs_required,
                "optional": inputs_optional,
            }

        # Filter for the nodes most relevant to audio/video generation.
        interesting = {k: v for k, v in all_nodes.items()
                       if any(kw in k.upper() for kw in ("LTX", "AUDIO", "AV", "SOUND"))}

        report = {
            "stream_id": STREAM_ID,
            "comfy_url": COMFY_URL,
            "total_nodes": len(all_nodes),
            "interesting_nodes": interesting,
            "all_node_names": sorted(all_nodes.keys()),
        }

        payload = json.dumps(report, indent=2).encode()
        req = urllib.request.Request(
            f"{CONTROL_PLANE_URL}/worker/debug/report",
            data=payload, method="POST",
            headers={
                "Authorization": f"Bearer {WORKER_SECRET}",
                "Content-Type": "application/json",
                "User-Agent": UA,
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            log(f"ComfyUI node report sent ({len(all_nodes)} nodes, {len(interesting)} interesting)")
    except Exception as e:
        log(f"Node report failed (non-fatal): {e}")


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    log(f"Worker started. Stream: {STREAM_ID}, total videos: {TOTAL_VIDEOS}")

    # Wait for ComfyUI to finish loading the model before claiming any jobs.
    # Without this, submit_workflow() times out because ComfyUI is still
    # loading 46 GB into VRAM, causing jobs to burn all max_attempts retries.
    wait_for_comfyui()

    # Report all available ComfyUI nodes back to the control plane for diagnostics.
    # This is how we discover the correct LTX-AV audio node names without SSH.
    report_comfy_nodes()

    idle_polls = 0
    rendered   = 0

    while True:
        job = None
        try:
            job = claim_job()
        except Exception as e:
            log(f"Error claiming job: {e}")
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if job is None:
            idle_polls += 1
            if idle_polls >= MAX_IDLE_POLLS:
                log("No more jobs after max idle polls. Exiting.")
                break
            log(f"No job available, waiting... ({idle_polls}/{MAX_IDLE_POLLS})")
            time.sleep(POLL_INTERVAL_SEC)
            continue

        idle_polls = 0
        job_id = job["job_id"]
        log(f"Rendering job {job_id} (seq {job.get('sequence_num', '?')})")

        try:
            workflow   = build_workflow(job)
            prompt_id  = submit_workflow(workflow)
            log(f"Submitted to ComfyUI as {prompt_id}")

            outputs    = wait_for_completion(prompt_id)
            video_path = find_output_video(outputs)

            if not video_path:
                raise FileNotFoundError("ComfyUI produced no output file")

            log(f"Render complete: {video_path}")
            r2_key = upload_video(job_id, video_path)
            log(f"Uploaded to {r2_key}")

            report_complete(job_id, r2_key)
            rendered += 1
            log(f"Job {job_id} done. Total rendered: {rendered}")

        except Exception as e:
            log(f"Job {job_id} failed: {e}")
            report_fail(job_id, str(e))

    log(f"Worker exiting. Rendered {rendered} videos.")


if __name__ == "__main__":
    main()
