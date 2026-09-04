/**
 * Regenerates the download manifest for speech models.
 *
 * The manifest is committed so a build never depends on Hugging Face being up
 * or on a repository's `main` having moved. Every entry pins a revision, and
 * carries the byte count and, where the source publishes one, the sha256 the
 * downloader verifies against.
 *
 * Run with: node apps/mobile/modules/t3-voice/scripts/generate-model-manifest.mts
 */

import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const MODEL_REPO = "argmaxinc/whisperkit-coreml";
const MODEL_REVISION = "0f63a7800b00dd0226abd051b906c246e1907482";

const TOKENIZER_REVISION_BY_MODEL: Record<string, { repo: string; revision: string }> = {
  "openai_whisper-small.en": {
    repo: "openai/whisper-small.en",
    revision: "main",
  },
  "openai_whisper-small": {
    repo: "openai/whisper-small",
    revision: "main",
  },
};

// WhisperKit resolves its tokenizer from the model folder before reaching for
// the network, so these ship alongside the weights. Without them a downloaded
// model still needs a connection the first time it runs.
const TOKENIZER_FILES = [
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json",
  "merges.txt",
  "special_tokens_map.json",
  "added_tokens.json",
];

const MODELS: Record<string, string> = {
  "whisper-small-en": "openai_whisper-small.en",
  "whisper-small": "openai_whisper-small",
};

/**
 * Cleanup models are one quantized GGUF each, so they need no tree walk. Every
 * entry pins the repository revision the file was published at, which is what
 * makes the checksum below stable.
 */
const CLEANUP_MODELS: Record<string, { repo: string; revision: string; file: string }> = {
  "qwen-0-8b": {
    repo: "unsloth/Qwen3.5-0.8B-GGUF",
    revision: "6ab461498e2023f6e3c1baea90a8f0fe38ab64d0",
    file: "Qwen3.5-0.8B-Q4_K_M.gguf",
  },
  "qwen-2b": {
    repo: "unsloth/Qwen3.5-2B-GGUF",
    revision: "f6d5376be1edb4d416d56da11e5397a961aca8ae",
    file: "Qwen3.5-2B-Q4_K_M.gguf",
  },
  "qwen-4b": {
    repo: "unsloth/Qwen3.5-4B-GGUF",
    revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
  },
};

type ManifestFile = {
  path: string;
  url: string;
  bytes: number;
  sha256: string;
};

type HubEntry = {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid?: string };
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return (await response.json()) as T;
}

async function resolveRevision(repo: string, revision: string): Promise<string> {
  if (revision !== "main") return revision;
  const meta = await fetchJson<{ sha: string }>(`https://huggingface.co/api/models/${repo}`);
  return meta.sha;
}

async function collectModelFiles(folder: string): Promise<ManifestFile[]> {
  const entries = await fetchJson<HubEntry[]>(
    `https://huggingface.co/api/models/${MODEL_REPO}/tree/${MODEL_REVISION}/${folder}?recursive=true`,
  );

  return (
    entries
      .filter((entry) => entry.type === "file")
      // `.mlpackage` is the uncompiled source beside the compiled `.mlmodelc`, and
      // `model.mlmodel` is its spec. Neither is read at runtime.
      .filter((entry) => !entry.path.includes(".mlpackage"))
      .filter((entry) => !entry.path.endsWith("/model.mlmodel"))
      .map((entry) => ({
        path: entry.path.slice(`${folder}/`.length),
        url: `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${entry.path}`,
        bytes: entry.size ?? 0,
        // Only LFS files publish a sha256. For the rest the downloader falls back
        // to a size check, which is what the source actually gives us.
        sha256: entry.lfs?.oid ?? "",
      }))
  );
}

async function collectTokenizerFiles(folder: string): Promise<ManifestFile[]> {
  const source = TOKENIZER_REVISION_BY_MODEL[folder];
  if (!source) throw new Error(`no tokenizer source for ${folder}`);

  const revision = await resolveRevision(source.repo, source.revision);
  const entries = await fetchJson<HubEntry[]>(
    `https://huggingface.co/api/models/${source.repo}/tree/${revision}`,
  );
  const bySize = new Map(entries.map((entry) => [entry.path, entry]));

  return TOKENIZER_FILES.filter((file) => bySize.has(file)).map((file) => ({
    path: file,
    url: `https://huggingface.co/${source.repo}/resolve/${revision}/${file}`,
    bytes: bySize.get(file)?.size ?? 0,
    sha256: bySize.get(file)?.lfs?.oid ?? "",
  }));
}

async function collectCleanupFile(modelId: string): Promise<ManifestFile[]> {
  const source = CLEANUP_MODELS[modelId];
  if (!source) throw new Error(`no cleanup source for ${modelId}`);

  const entries = await fetchJson<HubEntry[]>(
    `https://huggingface.co/api/models/${source.repo}/tree/${source.revision}`,
  );
  const entry = entries.find((candidate) => candidate.path === source.file);
  if (!entry) throw new Error(`${source.file} is not in ${source.repo}@${source.revision}`);

  return [
    {
      path: source.file,
      url: `https://huggingface.co/${source.repo}/resolve/${source.revision}/${source.file}`,
      bytes: entry.size ?? 0,
      sha256: entry.lfs?.oid ?? "",
    },
  ];
}

const manifest: Record<string, ManifestFile[]> = {};

for (const [modelId, folder] of Object.entries(MODELS)) {
  const files = [...(await collectModelFiles(folder)), ...(await collectTokenizerFiles(folder))];
  manifest[modelId] = files;
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`${modelId}: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB`);
}

for (const modelId of Object.keys(CLEANUP_MODELS)) {
  const files = await collectCleanupFile(modelId);
  manifest[modelId] = files;
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`${modelId}: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB`);
}

const outputPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "native",
  "voiceModelManifest.json",
);

await NodeFSP.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outputPath}`);
