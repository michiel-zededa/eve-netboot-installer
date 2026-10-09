// Texts come from eve/ui.json, which the sync writes in the configured
// language (ENI_LANGUAGE). The English file is built in as the fallback, so
// the page also works before the first sync or for a missing key.
import { createContext, useContext } from "react";
import en from "../../app/i18n/en.json";

export type Texts = Record<string, string>;

export const fallback: Texts = en as Texts;

export const TextsContext = createContext<Texts>(fallback);

/** t("ui_count_images", { n: 3 }) -> "3 images" */
export function useT() {
  const texts = useContext(TextsContext);
  return (key: string, vars?: Record<string, string | number>) => {
    let s = texts[key] ?? fallback[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}
