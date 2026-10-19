import { describe, expect, it } from "vitest";
import { sourceLabels, turnLocale, uiLocale } from "./ui-locale";

describe("source labels", () => {
  it("keeps English chrome for an English question", () => {
    expect(uiLocale("What is the general fund budget?")).toBe("en");
    expect(sourceLabels("en").sources).toBe("Sources");
    expect(sourceLabels("en").document).toBe("Document");
  });

  it("localizes source labels for a Spanish question", () => {
    expect(uiLocale("¿Cuál es el día de recolección de basura?")).toBe("es");
    expect(uiLocale("La ordenanza evita el escurrimiento")).toBe("es");
    expect(sourceLabels("es")).toMatchObject({
      sources: "Fuentes",
      document: "Documento",
      news: "Noticia",
    });
  });

  it("follows the current English question when the answer is still in Spanish", () => {
    expect(turnLocale("Does a fence need a permit?", "Se requiere un permiso de acuerdo con las reglas.")).toBe("en");
    expect(turnLocale("¿Se necesita un permiso para una cerca?", "A permit is required.")).toBe("es");
  });
});
