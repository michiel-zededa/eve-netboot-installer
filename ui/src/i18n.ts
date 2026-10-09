// Texts come from app/i18n/<lang>.json in the configured language
// (ENI_LANGUAGE): on the PXE server's port from eve/ui.json (written by the
// sync), on the appliance's management port from api/texts, which also works
// before the setup and for the language chosen in the web setup. The English
// file is built in as the fallback, for a missing file or key.
import { createContext, useContext } from "react";
import en from "../../app/i18n/en.json";

export type Texts = Record<string, string>;
export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

export const fallback: Texts = en as Texts;

export const TextsContext = createContext<Texts>(fallback);

export function translate(texts: Texts, key: string, vars?: Record<string, string | number>) {
  let s = texts[key] || fallback[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** t("ui_count_images", { n: 3 }) -> "3 images" */
export function useT(): TFunc {
  const texts = useContext(TextsContext);
  return (key, vars) => translate(texts, key, vars);
}

/** t for a key that may not exist (an optional help text): "" when missing. */
export function has(t: TFunc, key: string) {
  return t(key) !== key;
}

export const PRODUCT = "EVE Netboot Installer";
