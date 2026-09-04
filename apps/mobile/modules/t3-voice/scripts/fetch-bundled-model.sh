#!/usr/bin/env bash

# Fetches the speech model that ships inside the app.
#
# One model is bundled so dictation works offline on first launch. It is
# downloaded here rather than committed, because 73 MB of CoreML weights in git
# costs every clone forever; the app bundle is where it belongs, not history.
#
# Both sources are pinned to immutable revisions. Re-running is cheap: a
# complete download is detected by its manifest and skipped.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST_ROOT="${MODULE_DIR}/ios/BundledModels"
MODEL_NAME="openai_whisper-tiny.en"
DEST="${DEST_ROOT}/${MODEL_NAME}"

MODEL_REPO="argmaxinc/whisperkit-coreml"
MODEL_REVISION="0f63a7800b00dd0226abd051b906c246e1907482"

# WhisperKit looks for `tokenizer.json` inside the model folder before falling
# back to a network fetch, so the tokenizer ships in the same directory. Without
# it, first launch needs a connection and the offline guarantee is a lie.
TOKENIZER_REPO="openai/whisper-tiny.en"
TOKENIZER_REVISION="87c7102498dcde7456f24cfd30239ca606ed9063"
TOKENIZER_FILES=(
  tokenizer.json
  tokenizer_config.json
  vocab.json
  merges.txt
  special_tokens_map.json
  added_tokens.json
)

STAMP="${DEST}/.t3-voice-manifest"
EXPECTED_STAMP="v2 ${MODEL_REPO}@${MODEL_REVISION} ${TOKENIZER_REPO}@${TOKENIZER_REVISION}"

log() {
  printf '[t3-voice-model] %s\n' "$*"
}

die() {
  printf '[t3-voice-model] error: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "missing required command: curl"
command -v python3 >/dev/null 2>&1 || die "missing required command: python3"

if [[ -f "${STAMP}" ]] && [[ "$(cat "${STAMP}")" == "${EXPECTED_STAMP}" ]]; then
  log "already present, skipping"
  exit 0
fi

log "fetching ${MODEL_NAME} into ${DEST}"
rm -rf "${DEST}"
mkdir -p "${DEST}"

# The compiled `.mlmodelc` directories are what CoreML loads. The `.mlpackage`
# sources beside them double the download and are never read at runtime.
paths="$(
  curl -fsSL "https://huggingface.co/api/models/${MODEL_REPO}/tree/${MODEL_REVISION}/${MODEL_NAME}?recursive=true" |
    python3 -c '
import json, sys
for entry in json.load(sys.stdin):
    if entry["type"] != "file":
        continue
    if ".mlpackage" in entry["path"]:
        continue
    # `model.mlmodel` is the uncompiled spec sitting inside an already-compiled
    # `.mlmodelc`. CoreML never reads it, and Xcode tries to compile every
    # `.mlmodel` it finds in a resource bundle, so two of them collide on one
    # output path and the build fails.
    if entry["path"].endswith("/model.mlmodel"):
        continue
    print(entry["path"])
'
)"

[[ -n "${paths}" ]] || die "no model files listed for ${MODEL_NAME}"

while IFS= read -r path; do
  relative="${path#"${MODEL_NAME}"/}"
  target="${DEST}/${relative}"
  mkdir -p "$(dirname "${target}")"
  curl -fsSL --retry 3 \
    "https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${path}" \
    -o "${target}"
done <<<"${paths}"

for file in "${TOKENIZER_FILES[@]}"; do
  curl -fsSL --retry 3 \
    "https://huggingface.co/${TOKENIZER_REPO}/resolve/${TOKENIZER_REVISION}/${file}" \
    -o "${DEST}/${file}"
done

[[ -f "${DEST}/tokenizer.json" ]] || die "tokenizer.json missing; offline first launch would fail"

printf '%s' "${EXPECTED_STAMP}" >"${STAMP}"
log "done: $(du -sh "${DEST}" | cut -f1)"
