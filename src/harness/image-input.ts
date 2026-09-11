import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

type AgyImageContent = NonNullable<AgentHarnessAttemptParamsV2["images"]>[number];

export type MaterializedAgyImages = {
  prompt: string;
  paths: readonly string[];
  cleanup: () => Promise<void>;
};

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function decodeBase64Image(data: string, index: number): Buffer {
  const normalized = data.trim();
  if (!normalized || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new Error(`ANTIGRAVITY image ${index + 1} contains invalid base64 data`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) {
    throw new Error(`ANTIGRAVITY image ${index + 1} decoded to an empty payload`);
  }
  return decoded;
}

function extensionForMimeType(mimeType: string, index: number): string {
  const normalized = mimeType.trim().toLowerCase();
  const extension = MIME_EXTENSIONS[normalized];
  if (!extension) {
    throw new Error(
      `ANTIGRAVITY image ${index + 1} uses unsupported MIME type ${mimeType || "<empty>"}`,
    );
  }
  return extension;
}

function promptWithImagePaths(prompt: string, paths: readonly string[]): string {
  if (paths.length === 0) return prompt;
  return `${prompt}\n\n${paths.join("\n")}`;
}

export async function materializeAgyImages(params: {
  prompt: string;
  images?: readonly AgyImageContent[];
}): Promise<MaterializedAgyImages> {
  const images = params.images ?? [];
  if (images.length === 0) {
    return {
      prompt: params.prompt,
      paths: [],
      cleanup: async () => undefined,
    };
  }

  const directory = await mkdtemp(join(tmpdir(), "antigravity-images-"));
  const paths: string[] = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(directory, { recursive: true, force: true });
  };

  try {
    for (const [index, image] of images.entries()) {
      const extension = extensionForMimeType(image.mimeType, index);
      const bytes = decodeBase64Image(image.data, index);
      const path = join(directory, `image-${index + 1}${extension}`);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      paths.push(path);
    }
    return {
      prompt: promptWithImagePaths(params.prompt, paths),
      paths,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
