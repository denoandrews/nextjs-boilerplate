import { uiLocale } from "@/lib/ui-locale";

const LEVY_AMOUNT = /\$19,125,000\b/;
const ALREADY_DISTINGUISHED = /\bnot the general fund\b/i;

/**
 * The model has been labeling Oak Park's property tax levy as the general fund
 * budget. Say so in the first sentence when the question asked for the general
 * fund and the answer still treats the levy as that budget.
 */
export function clarifyLevyAnswer(question: string, answer: string): string {
  if (!/\bgeneral fund\b/i.test(question)) return answer;
  const mentionsLevy = /\b(?:property tax )?levy\b/i.test(answer) || LEVY_AMOUNT.test(answer);
  if (!mentionsLevy || ALREADY_DISTINGUISHED.test(answer)) return answer;
  const note = uiLocale(question) === "es"
    ? "Esa cifra es un gravamen del impuesto predial, no el presupuesto del fondo general."
    : "That figure is a property tax levy, not the general fund budget.";
  return `${note}\n\n${answer}`;
}
