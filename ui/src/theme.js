export function getTheme() {
    try {
        const t = localStorage.getItem("eni-theme");
        return t === "light" || t === "dark" ? t : "system";
    }
    catch {
        return "system";
    }
}
export function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try {
        localStorage.setItem("eni-theme", t);
    }
    catch {
        // private window or blocked storage: the theme just is not remembered
    }
}
