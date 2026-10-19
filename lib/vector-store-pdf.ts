/**
 * Read the opening pages of a PDF. Used only by the tagging script.
 * Chat search does not import this module.
 */
export async function extractOpeningPdfText(bytes: Uint8Array, pageLimit = 3): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const pages = Math.min(pdf.numPages, pageLimit);
  const parts: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) parts.push(text);
    }
  } finally {
    const closable = pdf as { destroy?: () => Promise<void> | void };
    if (typeof closable.destroy === "function") await closable.destroy();
  }
  return parts.join("\n").slice(0, 20000);
}
