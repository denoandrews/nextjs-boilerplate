import { describe, expect, it } from "vitest";

import { extractOpeningPdfText } from "./vector-store-pdf";
import { parseContentDate } from "./vector-store-tags";

function minimalPdf(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 120 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream\nendobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xref = body.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    table += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += table;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

describe("pdf opening text", () => {
  it("reads a meeting date from the first page", async () => {
    const text = await extractOpeningPdfText(minimalPdf("Meeting Date: May 6, 2025"));
    expect(text).toMatch(/May 6, 2025/);
    expect(parseContentDate(text).recordDate).toBe(20250506);
  }, 20000);
});