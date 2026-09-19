// Bounded reader for the portable USTAR subset produced by this project's npm
// pack command. It never extracts paths or follows archive links. New archive
// formats must be explicitly supported and tested before qualification uses them.
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function textField(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((byte) => byte !== 0)) throw new Error("Malformed tar text padding");
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(bytes) {
  const value = bytes.toString("ascii").replace(/[\0 ]+$/g, "").replace(/^ +/, "");
  if (!/^[0-7]+$/.test(value)) throw new Error("Unsupported tar numeric encoding");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error("Tar number exceeds safe range");
  return result;
}

function relativeName(name, directory) {
  if (directory && name === "package/") return "";
  if (!name.startsWith("package/")) throw new Error("Archive entries must be under package/");
  const relative = name.slice("package/".length).replace(directory ? /\/$/ : /$^/, "");
  if (!relative || relative.includes("\\") || /^[A-Za-z]:/.test(relative) ||
      relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe archive path");
  return relative;
}

export async function archiveEntries(file) {
  const chunks = [];
  let compressedBytes = 0;
  for await (const chunk of createReadStream(file)) {
    compressedBytes += chunk.length;
    if (compressedBytes > MAX_COMPRESSED) throw new Error("Compressed package exceeds 32 MiB limit");
    chunks.push(chunk);
  }
  const tar = gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_EXPANDED });
  if (tar.length % 512 !== 0) throw new Error("Truncated tar block");
  const result = [], seen = new Set();
  let cursor = 0, count = 0, ended = false;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) {
      if (cursor + 1024 > tar.length || tar.subarray(cursor).some((byte) => byte !== 0)) throw new Error("Tar requires two zero end blocks and zero trailing padding");
      ended = true;
      break;
    }
    if (++count > MAX_ENTRIES) throw new Error("Package exceeds 4096 entry limit");
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum) throw new Error("Tar header checksum mismatch");
    if (textField(header.subarray(257, 263)) !== "ustar" || header.toString("ascii", 263, 265) !== "00") throw new Error("Unsupported tar format; portable USTAR required");
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) throw new Error("Unsupported tar entry type; links and extended headers are forbidden");
    if (textField(header.subarray(157, 257))) throw new Error("Tar links are forbidden");
    const size = octal(header.subarray(124, 136));
    if (size > MAX_FILE || (type === 53 && size !== 0)) throw new Error("Invalid tar payload size");
    const prefix = textField(header.subarray(345, 500));
    const name = relativeName(`${prefix ? prefix + "/" : ""}${textField(header.subarray(0, 100))}`, type === 53);
    if (seen.has(name)) throw new Error(`Duplicate archive path: ${name}`);
    seen.add(name);
    cursor += 512;
    if (cursor + Math.ceil(size / 512) * 512 > tar.length) throw new Error("Truncated tar payload");
    if (type !== 53) result.push([name, digest(tar.subarray(cursor, cursor + size))]);
    if (tar.subarray(cursor + size, cursor + Math.ceil(size / 512) * 512).some((byte) => byte !== 0)) throw new Error("Nonzero tar payload padding");
    cursor += Math.ceil(size / 512) * 512;
  }
  if (!ended || result.length === 0) throw new Error("Package is empty or missing tar end blocks");
  return result.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
