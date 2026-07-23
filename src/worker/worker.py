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
import subprocess
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
# Delivery fps for max (30 default / 32 alt) — set from the first claimed job.
RENDER_FPS        = 30
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
# Only meaningful for the LTX modes (flex/max); max2 never uses it — its sound
# request is downgraded to silent in build_workflow.
# Only flex renders with LTX now — max is the Wan pipeline and never loads this.
LTX_CHECKPOINT = "ltx-2.3-22b-distilled-1.1.safetensors"


def build_workflow(job: dict) -> dict:
    wf = fetch_workflow()
    prompt        = job["prompt_text"]
    width         = int(job.get("width", 768))
    height        = int(job.get("height", 512))
    fps           = int(job.get("fps", 24))
    duration      = int(job.get("duration_secs", 5))
    seed          = random.randint(0, 2**32 - 1)
    global RENDER_FPS
    if MODE in ("max", "max2"):  # max2 = legacy env on pre-collapse instances
        # Wan 2.2 is 16 fps-native (81 frames = 5 s); smooth output comes from
        # in-graph RIFE interpolation, calibrated live with the operator:
        #   fps 30 (default): RIFE ×4 → 64 fps grid → even fps=30 pick in the
        #     finish (≤8 ms timing error — the naive ×2→32→drop-to-30 produced
        #     visible speed-up/slow-down rhythm the operator caught immediately)
        #   fps 32: RIFE ×2 → 32 fps container, zero dropped frames
        nframes = 16 * duration + 1
        rife_mult = 2 if fps == 32 else 4
        combine_fps = 16 * rife_mult
        RENDER_FPS = 32 if fps == 32 else 30
    else:
        nframes = frames_for_duration(fps, duration)
        rife_mult = None
        combine_fps = fps
    sound_enabled = bool(job.get("sound_enabled", False))
    if sound_enabled and MODE in ("max", "max2"):
        # The AV-latent injection below is LTX-specific: it adds LTXVAudio*
        # nodes and references the LTX checkpoint, which a max2 (Wan) instance
        # never downloads. Injecting it into the Wan graph would fail ComfyUI
        # validation on EVERY job — render silent video instead of poisoning
        # the whole stream.
        log("sound_enabled ignored in max2 mode (Wan graph has no audio path)")
        sound_enabled = False

    replacements = {
        "__PROMPT__":     prompt,
        "__WIDTH__":      width,
        "__HEIGHT__":     height,
        "__NUM_FRAMES__": nframes,
        "__FPS__":        fps,
        "__RIFE_MULT__":  rife_mult if rife_mult else 1,
        "__COMBINE_FPS__": combine_fps,
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


# Render-time budget per mode. Flex: 8 steps, CFG 1 → minutes. Max: 24 steps at
# CFG 3.5 is ~6× the model evals (cond+uncond per step), so a 10 s clip can pass
# 10 real minutes on an RTX PRO 6000 — a flat 600 s would time out every long max
# render and (worse) leave it running: see the interrupt logic below.
# Max2 needs the same budget: the Wan 2.2 dual-expert graph loads and runs TWO
# 14B fp8 models sequentially on a 32 GB RTX 5090. Only flex keeps 600 s.
RENDER_TIMEOUT_SEC = 600 if MODE == "flex" else 2400


def interrupt_render() -> None:
    """Best-effort: stop the in-flight ComfyUI render and drop queued prompts.

    Without this, a timed-out prompt keeps rendering; the next claimed job queues
    BEHIND it and also times out, cascading until every job in the stream has
    burned its attempts while the GPU grinds on one zombie render.
    """
    for path, payload in (("/interrupt", b"{}"), ("/queue", b'{"clear": true}')):
        try:
            req = urllib.request.Request(f"{COMFY_URL}{path}", data=payload,
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:
            log(f"interrupt_render {path} failed (non-fatal): {e}")


def wait_for_completion(prompt_id: str, timeout_sec: int = RENDER_TIMEOUT_SEC) -> dict:
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

    # Kill the zombie render BEFORE surfacing the timeout, so the next job starts
    # on an idle GPU instead of queueing behind this one.
    interrupt_render()
    raise TimeoutError(f"ComfyUI render timed out after {timeout_sec}s")


def film_finish(video_path: str) -> str:
    """Finish pass for max — the operator-approved "real video" look.

    Calibrated live (2026-07-23): muted color (no vibrance — saturated output
    reads as AI), lifted shadows with rolled highlights, clarity + fine sharpen
    (the honest phone-camera tell), light denoise BEFORE sharpening, upscale to
    delivery 1080×1920. fps handling matches the RIFE grid built in-graph:
    stream fps 30 → even pick from the 64 fps grid; fps 32 → keep every frame.

    Best-effort: on any failure the ORIGINAL file is uploaded.
    """
    out = str(Path(video_path).with_suffix("")) + "_finish.mp4"
    fps_tail = ",fps=30" if RENDER_FPS == 30 else ""
    vf = (
        "hqdn3d=1.5:1.5:3:3,"
        "curves=all='0/0 0.05/0.09 0.5/0.51 0.9/0.89 1/0.97',"
        "unsharp=luma_msize_x=13:luma_msize_y=13:luma_amount=0.28,"
        "cas=0.4,"
        "eq=saturation=0.93,"
        "scale=trunc(iw*1.5/2)*2:trunc(ih*1.5/2)*2:flags=lanczos" + fps_tail  # ×1.5 keeps EVERY aspect (704×1280→1056×1920, 1280×704→1920×1056, 960²→1440²)
    )
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", video_path,
        "-vf", vf,
        "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "copy",
        out,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            log(f"film_finish ffmpeg failed (uploading original): {r.stderr[-300:]}")
            return video_path
        if not Path(out).exists() or Path(out).stat().st_size < 1000:
            log("film_finish produced empty output — uploading original")
            return video_path
        log(f"film_finish applied: {out}")
        return out
    except Exception as e:
        log(f"film_finish error (uploading original): {e}")
        return video_path


def qc_check(video_path: str) -> str | None:
    """Cheap defect heuristics on the RAW render (before the film finish).

    Returns a rejection reason, or None if the clip passes. Curation is how
    frontier showcases look frontier — this is the automated first tier of it:
    catch the hard failures (dead-black spans, frozen video) that no amount of
    grading rescues, and give the job one fresh-seed retry instead of shipping
    a broken clip to the channel.
    """
    try:
        r = subprocess.run(
            ["ffmpeg", "-i", video_path,
             "-vf", "blackdetect=d=0.5:pix_th=0.08,freezedetect=n=-50dB:d=1.5",
             "-an", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120,
        )
        err = r.stderr
        if "blackdetect" in err and "black_start" in err:
            return "black span >=0.5s"
        if "freezedetect" in err and "freeze_start" in err:
            return "frozen video >=1.5s"
        return None
    except Exception as e:
        log(f"qc_check error (passing clip through): {e}")
        return None


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
            # Up to 2 attempts per job: a clip that fails the defect heuristics
            # gets ONE fresh-seed re-render before we accept whatever came out
            # (shipping the second attempt regardless keeps the stream moving —
            # QC must never deadlock a job).
            video_path = None
            for qc_attempt in (1, 2):
                workflow   = build_workflow(job)
                prompt_id  = submit_workflow(workflow)
                log(f"Submitted to ComfyUI as {prompt_id} (attempt {qc_attempt})")

                outputs    = wait_for_completion(prompt_id)
                video_path = find_output_video(outputs)

                if not video_path:
                    raise FileNotFoundError("ComfyUI produced no output file")

                reason = qc_check(video_path) if MODE in ("max", "max2") else None
                if reason is None:
                    break
                log(f"QC reject (attempt {qc_attempt}): {reason} — re-rendering with fresh seed")

            log(f"Render complete: {video_path}")
            # Film-emulation finish applies to both premium modes — max2 output
            # targets the same physically-grained showcase look as max.
            if MODE in ("max", "max2"):
                video_path = film_finish(video_path)
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
