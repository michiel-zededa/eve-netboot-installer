// Light / Dark / System, like the ZEDEDA UI's appearance menu. Kept in the
// browser only (localStorage); the inline script in index.html applies it
// before the first paint.
export type Theme = "light" | "dark" | "system";

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem("eni-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("eni-theme", t);
  } catch {
    // private window or blocked storage: the theme just is not remembered
  }
}
