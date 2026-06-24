#!/usr/bin/env bash
# Launch Ollama with KV-cache optimisations for long sessions.
#
# Problem: llama.cpp KV-cache fragmentation on Apple Silicon causes VibeThinker-3B
# throughput to decay from ~100 tok/s to ~10 tok/s over several hours of sustained
# generation. These two env vars halve KV-cache VRAM usage by quantising cached
# keys/values to 8-bit integers, which keeps num_ctx=32K affordable (~1.6 GB instead
# of ~3.2 GB) and significantly slows the fragmentation decay — with negligible
# quality loss (<0.5% on typical code benchmarks).
#
# Use this script instead of a bare `ollama serve` for any session longer than ~1 hour.
# The smallcode throughput watchdog (src/provider/watchdog.ts) will still detect decay
# and unload/reload the model automatically, but starting here defers the first
# fragmentation event considerably.
#
# Usage:
#   chmod +x scripts/ollama-serve.sh   # already executable after git checkout
#   scripts/ollama-serve.sh            # replaces your current `ollama serve`
#   scripts/ollama-serve.sh --port 11435  # forward extra flags to ollama serve
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0

exec ollama serve "$@"
