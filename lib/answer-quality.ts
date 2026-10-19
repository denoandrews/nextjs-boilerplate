import { uiLocale } from "@/lib/ui-locale";

const LEVY_MENTION = /\$19,125,000\b|\blevy\b|gravamen|impuesto predial/i;
const COPIED_OPENING =
  /^(?:That figure is a property tax levy, not the general fund budget\.|Esa cifra es un gravamen del impuesto predial, no el presupuesto del fondo general\.)(?:\s|\n)*/;

/**
 * The canned levy warning is only for a turn where the user, or an earlier
 * turn, actually mentioned the levy. A general-fund question should open with
 * the general fund total instead.
 */
export function clarifyLevyAnswer(question: string, answer: string, history = ""): string {
  const asked = `${history}\n${question}`;
  if (!LEVY_MENTION.test(asked)) return answer.replace(COPIED_OPENING, "").trim();
  if (!/\bgeneral fund\b/i.test(question) && !/\bfondo general\b/i.test(question)) return answer;
  if (!LEVY_MENTION.test(answer) || /\bnot the general fund\b/i.test(answer)) return answer;
  const note = uiLocale(question) === "es"
    ? "Esa cifra es un gravamen del impuesto predial, no el presupuesto del fondo general."
    : "That figure is a property tax levy, not the general fund budget.";
  return `${note}\n\n${answer}`;
}
