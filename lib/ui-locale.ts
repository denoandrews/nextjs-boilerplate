export type UiLocale = "en" | "es";

const SPANISH_WORDS =
  /\b(el|la|los|las|que|para|por|como|cómo|dónde|donde|una|unas|basura|recolección|recoleccion|ordenanza|día|dia|cuál|cual|fuentes)\b/gi;

export function uiLocale(text: string): UiLocale {
  if (/[¿¡ñÑ]/.test(text)) return "es";
  const hits = text.match(SPANISH_WORDS);
  return (hits?.length ?? 0) >= 2 ? "es" : "en";
}

/** Labels follow the current question, not an earlier turn or a mismatched answer. */
export function turnLocale(question: string | undefined, messageText = ""): UiLocale {
  const current = question?.trim();
  return uiLocale(current || messageText);
}

export function sourceLabels(locale: UiLocale) {
  if (locale === "es") {
    return {
      sources: "Fuentes",
      document: "Documento",
      news: "Noticia",
      tryAgain: "Intentar de nuevo",
      you: "Tú",
      newChat: "Nuevo chat",
      meetingsPage: "página de reuniones",
      meetingsPageTitle: "Abre la página de reuniones del Village Board, no el PDF.",
    };
  }
  return {
    sources: "Sources",
    document: "Document",
    news: "News",
    tryAgain: "Try again",
    you: "You",
    newChat: "New chat",
    meetingsPage: "meetings page",
    meetingsPageTitle: "Opens the Village Board meetings page, not this PDF.",
  };
}
