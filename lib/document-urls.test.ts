import { describe, expect, it } from "vitest";
import { documentSourceUrls } from "./document-urls";

describe("document source urls", () => {
  it("does nothing when Supabase is not configured", async () => {
    await expect(documentSourceUrls("municipality-1", ["file-1"])).resolves.toEqual(new Map());
    await expect(documentSourceUrls(null, ["file-1"])).resolves.toEqual(new Map());
  });
});
