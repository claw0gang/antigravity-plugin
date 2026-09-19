import fs from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { AgentHarnessAttemptParamsV2 } from "../host/types.js";

type AgyImageContent = NonNullable<AgentHarnessAttemptParamsV2["images"]>[number];

/** Limits must come from the host media policy; these are not native AGY defaults. */
export type AgyImageMediaPolicy = {
  maxImages: number;
  maxEncodedBytes: number;
  maxDecodedBytes: number;
  maxTotalDecodedBytes: number;
};

export type AgyImageCleanupState = "pending" | "in_progress" | "blocked" | "failed" | "complete";

export type MaterializedAgyImages = {
  prompt: string;
  paths: readonly string[];
  readonly cleanupState: AgyImageCleanupState;
  cleanup: () => Promise<void>;
};

/** Retains the failed staging cleanup handle so the owner can report and retry it. */
export class AgyImageStagingError extends AggregateError {
  constructor(stagingError: unknown, cleanupError: unknown, readonly images: MaterializedAgyImages) {
    super([stagingError, cleanupError], "ANTIGRAVITY image staging failed and cleanup is incomplete");
    this.name = "AgyImageStagingError";
  }
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function validatePolicy(policy: AgyImageMediaPolicy | undefined): asserts policy is AgyImageMediaPolicy {
  if (!policy || [policy.maxImages, policy.maxEncodedBytes, policy.maxDecodedBytes,
    policy.maxTotalDecodedBytes].some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("ANTIGRAVITY images require explicit positive host media-policy limits");
  }
}

async function validateStagingRoot(stagingRoot: string | undefined): Promise<string> {
  if (typeof stagingRoot !== "string" || !stagingRoot || !isAbsolute(stagingRoot)) {
    throw new Error("ANTIGRAVITY image staging requires an absolute OpenClaw workspace directory");
  }
  let info;
  try { info = await fs.stat(stagingRoot); }
  catch { throw new Error("ANTIGRAVITY image staging workspace is unavailable"); }
  if (!info.isDirectory()) throw new Error("ANTIGRAVITY image staging workspace is not a directory");
  return stagingRoot;
}

function decodeBase64Image(data: unknown, index: number, policy: AgyImageMediaPolicy, remainingDecodedBytes: number): Buffer {
  if (typeof data !== "string" || !data || data.length % 4 !== 0) {
    throw new Error(`ANTIGRAVITY image ${index + 1} contains invalid base64 data`);
  }
  // Bound the supplied representation before validation or allocating a decoded copy.
  if (Buffer.byteLength(data, "utf8") > policy.maxEncodedBytes) {
    throw new Error(`ANTIGRAVITY image ${index + 1} exceeds the encoded media-policy limit`);
  }
  if (/[^A-Za-z0-9+/=]/u.test(data) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
    throw new Error(`ANTIGRAVITY image ${index + 1} contains invalid base64 data`);
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedSize = (data.length / 4) * 3 - padding;
  if (decodedSize > policy.maxDecodedBytes) {
    throw new Error(`ANTIGRAVITY image ${index + 1} exceeds the decoded media-policy limit`);
  }
  if (decodedSize > remainingDecodedBytes) {
    throw new Error("ANTIGRAVITY images exceed the total decoded host media-policy limit");
  }
  const decoded = Buffer.from(data, "base64");
  // Buffer.from silently accepts bad pad bits and some malformed encodings.
  if (!decoded.length || decoded.length !== decodedSize || decoded.toString("base64") !== data) {
    throw new Error(`ANTIGRAVITY image ${index + 1} contains invalid base64 data`);
  }
  return decoded;
}

function extensionForMimeType(mimeType: unknown, index: number): { mime: string; extension: string } {
  const mime = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  const extension = Object.hasOwn(MIME_EXTENSIONS, mime) ? MIME_EXTENSIONS[mime] : undefined;
  if (!extension) {
    // Never echo arbitrary untrusted content or payloads into errors/telemetry.
    throw new Error(`ANTIGRAVITY image ${index + 1} uses an unsupported MIME type`);
  }
  return { mime, extension };
}

function validateSignature(bytes: Buffer, mime: string, index: number): void {
  const matches = mime === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg" || mime === "image/jpg"
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === "image/gif"
        ? ["GIF87a", "GIF89a"].some((magic) => bytes.subarray(0, 6).equals(Buffer.from(magic)))
        : bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF"))
          && bytes.subarray(8, 12).equals(Buffer.from("WEBP"));
  if (!matches) throw new Error(`ANTIGRAVITY image ${index + 1} payload does not match its MIME type`);
  // Signature validation is not full image decoding or native modality qualification.
}

export async function materializeAgyImages(params: {
  prompt: string;
  images?: readonly AgyImageContent[];
  mediaPolicy?: AgyImageMediaPolicy;
  /** OpenClaw-resolved workspace boundary for this attempt. */
  stagingRoot?: string;
  /** True only before reader admission or after all owned readers have settled. */
  readersSettled?: () => boolean;
}): Promise<MaterializedAgyImages> {
  const images = params.images === undefined ? [] : params.images;
  if (!Array.isArray(images)) throw new Error("ANTIGRAVITY images must be an ordered image list");
  if (images.length === 0) {
    return { prompt: params.prompt, paths: [], cleanupState: "complete", cleanup: async () => undefined };
  }
  validatePolicy(params.mediaPolicy);
  if (typeof params.readersSettled !== "function") {
    throw new Error("ANTIGRAVITY image cleanup requires an explicit reader-settlement gate");
  }
  if (images.length > params.mediaPolicy.maxImages) {
    throw new Error("ANTIGRAVITY images exceed the host media-policy count limit");
  }

  // Validate the whole ordered batch before creating files, including aggregate memory bounds.
  let totalDecodedBytes = 0;
  const validated = Array.from(images, (image, index) => {
    if (!image || image.type !== "image") throw new Error(`ANTIGRAVITY image ${index + 1} is malformed`);
    const { mime, extension } = extensionForMimeType(image.mimeType, index);
    const bytes = decodeBase64Image(image.data, index, params.mediaPolicy!,
      params.mediaPolicy!.maxTotalDecodedBytes - totalDecodedBytes);
    totalDecodedBytes += bytes.length;
    validateSignature(bytes, mime, index);
    return { extension, bytes };
  });

  const stagingRoot = await validateStagingRoot(params.stagingRoot);
  // Keep transport bytes inside the exact OpenClaw workspace authority already
  // selected for this attempt. Do not infer $HOME, a Gateway state root or /tmp.
  const directory = await fs.mkdtemp(join(stagingRoot, ".antigravity-images-"));
  const paths: string[] = [];
  let cleanupState: AgyImageCleanupState = "pending";
  let cleanupAttempt: Promise<void> | undefined;
  let published = false;
  const cleanup = (): Promise<void> => {
    if (cleanupState === "complete") return Promise.resolve();
    if (cleanupAttempt) return cleanupAttempt;
    // Staging failures have never published paths to a reader. Returned files require the gate.
    if (published) {
      try {
        if (!params.readersSettled!()) throw new Error("ANTIGRAVITY image readers have not settled; files retained");
      } catch (error) {
        cleanupState = "blocked";
        return Promise.reject(error);
      }
    }
    cleanupState = "in_progress";
    cleanupAttempt = Promise.resolve().then(async () => {
      try {
        await fs.rm(directory, { recursive: true, force: true });
        cleanupState = "complete";
      } catch (error) {
        cleanupState = "failed";
        throw error;
      } finally {
        cleanupAttempt = undefined;
      }
    });
    return cleanupAttempt;
  };

  try {
    for (const [index, image] of validated.entries()) {
      const path = join(directory, `image-${index + 1}${image.extension}`);
      await fs.writeFile(path, image.bytes, { flag: "wx", mode: 0o600 });
      paths.push(path);
    }
    published = true;
    return {
      prompt: `${params.prompt}\n\n${paths.join("\n")}`,
      paths: Object.freeze([...paths]),
      get cleanupState() { return cleanupState; },
      cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AgyImageStagingError(error, cleanupError, {
        prompt: params.prompt,
        paths: Object.freeze([...paths]),
        get cleanupState() { return cleanupState; },
        cleanup,
      });
    }
    throw error;
  }
}
