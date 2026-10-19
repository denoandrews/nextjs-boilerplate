import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type CachedScan = {
  filename: string;
  text: string | null;
  contentMethod: "file" | "pdf" | "vector-store" | "none";
  fetchedContent: boolean;
};

export function cacheFilePath(directory: string, vectorStoreId: string, fileId: string): string {
  if (!/^[\w-]+$/.test(vectorStoreId) || !/^[\w-]+$/.test(fileId)) {
    throw new Error("Refusing to build a cache path from an unexpected id.");
  }
  return path.join(directory, vectorStoreId, `${fileId}.json`);
}

export async function readScanCache(directory: string, vectorStoreId: string, fileId: string): Promise<CachedScan | null> {
  try {
    const raw = await readFile(cacheFilePath(directory, vectorStoreId, fileId), "utf8");
    const parsed = JSON.parse(raw) as Partial<CachedScan>;
    if (typeof parsed.filename !== "string" || typeof parsed.fetchedContent !== "boolean") return null;
    if (parsed.text != null && typeof parsed.text !== "string") return null;
    return {
      filename: parsed.filename,
      text: parsed.text ?? null,
      contentMethod: parsed.contentMethod ?? "none",
      fetchedContent: parsed.fetchedContent,
    };
  } catch {
    return null;
  }
}

export async function writeScanCache(
  directory: string,
  vectorStoreId: string,
  fileId: string,
  entry: CachedScan,
): Promise<void> {
  const filePath = cacheFilePath(directory, vectorStoreId, fileId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(entry));
}
