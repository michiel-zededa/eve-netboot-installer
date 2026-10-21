import { jsx as _jsx } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { getSession, api, setApiLanguage } from "./admin";
import { loadActivity, loadStatus, loadTexts } from "./api";
import { ToastHost } from "./forms";
import { fallback, TextsContext } from "./i18n";
import Layout from "./Layout";
import Boot from "./pages/Boot";
import Home from "./pages/Home";
import Images from "./pages/Images";
import { ConfirmNetwork, Login } from "./pages/Login";
import { Backup, Logs, System, Updates } from "./pages/Maintenance";
import Settings from "./pages/Settings";
import Setup from "./pages/Setup";
import { SECTIONS } from "./sections";
const POLL_MS = 10_000;
function parseHash() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    switch (parts[0]) {
        case "images":
            return { page: "images", tab: parts[1] === "github" || parts[1] === "local" ? parts[1] : "all" };
        case "boot":
            return { page: "boot" };
        case "settings": {
            const section = SECTIONS.find((s) => s.id === parts[1])?.id ?? "network";
            return { page: "settings", section };
        }
        case "logs":
        case "updates":
        case "backup":
        case "system":
            return { page: parts[0] };
        case "confirm":
            return { page: "confirm", token: parts[1] ?? "" };
        default:
            return { page: "home" };
    }
}
export function href(route) {
    switch (route.page) {
        case "images":
            return route.tab === "all" ? "#/images" : `#/images/${route.tab}`;
        case "settings":
            return `#/settings/${route.section}`;
        case "confirm":
            return `#/confirm/${route.token}`;
        case "home":
            return "#/";
        default:
            return `#/${route.page}`;
    }
}
export default function App() {
    const [route, setRoute] = useState(parseHash);
    const [status, setStatus] = useState(null);
    const [activity, setActivity] = useState(null);
    const [texts, setTexts] = useState(fallback);
    const [loaded, setLoaded] = useState(false);
    const [search, setSearch] = useState("");
    // undefined = still checking; null = plain PXE server (read-only)
    const [session, setSession] = useState(undefined);
    const [info, setInfo] = useState(null);
    const refresh = useCallback(async () => {
        const [s, a] = await Promise.all([loadStatus(), loadActivity()]);
        if (s)
            setStatus(s);
        setActivity(a);
        setLoaded(true);
    }, []);
    const applyTexts = useCallback((t) => {
        if (!t)
            return;
        setTexts({ ...fallback, ...t.texts });
        document.documentElement.lang = t.language;
        setApiLanguage(t.language);
    }, []);
    // the appliance's management port: texts from the API, in any language
    // (the web setup switches as soon as a language is chosen)
    const changeLanguage = useCallback((lang) => {
        api.texts(lang).then(applyTexts).catch(() => { });
    }, [applyTexts]);
    const refreshSession = useCallback(async () => {
        const s = await getSession();
        setSession(s);
        if (s)
            changeLanguage();
        else
            loadTexts().then(applyTexts);
        if (s?.authenticated)
            api.settings().then(setInfo).catch(() => { });
    }, [changeLanguage, applyTexts]);
    useEffect(() => {
        const onHash = () => setRoute(parseHash());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);
    useEffect(() => {
        refreshSession();
        refresh();
        const id = setInterval(refresh, POLL_MS);
        return () => clearInterval(id);
    }, [refresh, refreshSession]);
    const onSearch = (q) => {
        setSearch(q);
        if (q && route.page !== "images")
            location.hash = href({ page: "images", tab: "all" });
    };
    let content;
    if (session === undefined) {
        content = null;
    }
    else if (route.page === "confirm") {
        content = _jsx(ConfirmNetwork, { token: route.token });
    }
    else if (session && !session.configured) {
        content = _jsx(Setup, { onLanguage: changeLanguage, onDone: () => { location.hash = "#/"; refreshSession(); refresh(); } });
    }
    else if (session && !session.authenticated) {
        content = _jsx(Login, { hostname: session.hostname, onLogin: refreshSession });
    }
    else {
        const admin = !!session?.authenticated;
        content = (_jsx(Layout, { route: route, status: status, search: search, onSearch: onSearch, onRefresh: refresh, session: session, onLogout: () => api.logout().finally(refreshSession), children: !loaded ? null : route.page === "images" ? (_jsx(Images, { status: status, activity: activity, tab: route.tab, search: search, onSearch: setSearch, admin: admin, onChanged: refresh })) : route.page === "boot" ? (_jsx(Boot, { status: status })) : admin && route.page === "settings" ? (_jsx(Settings, { section: route.section, onSaved: () => changeLanguage() })) : admin && route.page === "logs" ? (_jsx(Logs, {})) : admin && route.page === "updates" ? (_jsx(Updates, { info: info })) : admin && route.page === "backup" ? (_jsx(Backup, { onSaved: () => changeLanguage() })) : admin && route.page === "system" ? (_jsx(System, {})) : (_jsx(Home, { status: status, activity: activity })) }));
    }
    return (_jsx(TextsContext.Provider, { value: texts, children: _jsx(ToastHost, { children: content }) }));
}
