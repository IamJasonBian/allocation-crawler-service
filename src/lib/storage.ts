import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Simple filesystem blob storage — replaces @netlify/blobs.
 *
 * Files are stored under DATA_DIR (default: ./data/blobs/<storeName>/).
 * On Render, mount a persistent disk at /data and set DATA_DIR=/data.
 */

const BASE_DIR = process.env.DATA_DIR || join(process.cwd(), "data");

export function getStore(storeName: string) {
  const storeDir = join(BASE_DIR, "blobs", storeName);

  return {
    async get(key: string, opts?: { type?: "arrayBuffer" }): Promise<ArrayBuffer | null> {
      const filePath = join(storeDir, key);
      try {
        const buf = await readFile(filePath);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      } catch {
        return null;
      }
    },

    async set(
      key: string,
      data: ArrayBuffer | Buffer,
      opts?: { metadata?: Record<string, string> },
    ): Promise<void> {
      const filePath = join(storeDir, key);
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(filePath, Buffer.from(data));

      // Store metadata as a sidecar JSON file
      if (opts?.metadata) {
        await writeFile(`${filePath}.meta.json`, JSON.stringify(opts.metadata));
      }
    },
  };
}
