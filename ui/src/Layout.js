import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, CloudDownload, CloudUpload, Disc3, Download, HardDrive, House, KeyRound, Languages, Layers, LogOut, Menu, Router, Monitor, Moon, Network, RefreshCw, ScrollText, Search, Server, Settings2, Share2, ShieldCheck, Sun, Wrench, X, } from "lucide-react";
import { href } from "./App";
import { PRODUCT, useT } from "./i18n";
import { getTheme, setTheme } from "./theme";
export default function Layout({ route, status, search, onSearch, onRefresh, session, onLogout, children }) {
    const t = useT();
    const [navOpen, setNavOpen] = useState(false);
    const [searching, setSearching] = useState(false);
    const searchRef = useRef(null);
    // Ctrl/Cmd+K focuses the search, like the ZEDEDA UI
    useEffect(() => {
        const onKey = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setSearching(true);
                searchRef.current?.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    useEffect(() => setNavOpen(false), [route]);
    const count = status?.entries.length ?? 0;
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    return (_jsxs("div", { className: "shell", children: [_jsxs("header", { className: `topbar${searching ? " searching" : ""}`, children: [_jsx("button", { className: "icon-btn nav-toggle", "aria-label": t("adm_menu"), onClick: () => setNavOpen(!navOpen), children: navOpen ? _jsx(X, { size: 20 }) : _jsx(Menu, { size: 20 }) }), _jsx("a", { className: "brand", href: "#/", "aria-label": "ZEDEDA", children: _jsx("span", { className: "logo" }) }), _jsx("div", { className: "product", children: PRODUCT }), _jsxs("label", { className: "search", children: [_jsx(Search, { size: 18 }), _jsx("input", { ref: searchRef, value: search, placeholder: t("ui_search"), onChange: (e) => onSearch(e.target.value), onBlur: () => { if (!search)
                                    setSearching(false); } }), _jsx("kbd", { children: isMac ? "⌘K" : "Ctrl K" })] }), _jsx("button", { className: "icon-btn search-toggle", "aria-label": t("ui_search"), onClick: () => { setSearching(true); setTimeout(() => searchRef.current?.focus()); }, children: _jsx(Search, { size: 19 }) }), _jsxs("div", { className: "top-actions", children: [!session && status?.config.admin_url && (_jsxs("a", { className: "btn slim manage", href: status.config.admin_url, children: [_jsx(Settings2, { size: 16 }), " ", _jsx("span", { children: t("ui_manage") })] })), _jsx("button", { className: "icon-btn", title: t("ui_refresh"), "aria-label": t("ui_refresh"), onClick: onRefresh, children: _jsx(RefreshCw, { size: 19 }) }), _jsx(ThemeMenu, {}), session?.authenticated && _jsx(UserMenu, { hostname: session.hostname, version: session.version, onLogout: onLogout })] })] }), _jsxs("aside", { className: `sidebar${navOpen ? " open" : ""}`, children: [_jsxs("div", { className: "side-head", children: [_jsx("h2", { children: t("ui_side_title") }), _jsx("p", { children: t("ui_side_subtitle") })] }), _jsxs("nav", { children: [_jsx(NavItem, { to: { page: "home" }, route: route, icon: _jsx(House, { size: 20 }), label: t("ui_nav_home") }), _jsx(NavItem, { to: { page: "images", tab: "all" }, route: route, icon: _jsx(Layers, { size: 20 }), label: t("ui_section_images"), count: count }), _jsxs(NavGroup, { label: t("ui_section_network_boot"), children: [_jsx(NavItem, { to: { page: "boot" }, route: route, icon: _jsx(Network, { size: 20 }), label: t("ui_nav_boot") }), _jsxs("a", { className: "nav-item", href: "eve/", target: "_blank", rel: "noreferrer", children: [_jsx(Disc3, { size: 20 }), _jsx("span", { children: t("ui_nav_files") })] })] }), session?.authenticated && (_jsxs(_Fragment, { children: [_jsxs(NavGroup, { label: t("adm_nav_settings"), children: [_jsx(NavItem, { to: { page: "settings", section: "network" }, route: route, icon: _jsx(Network, { size: 20 }), label: t("adm_sec_network") }), _jsx(NavItem, { to: { page: "settings", section: "server" }, route: route, icon: _jsx(Server, { size: 20 }), label: t("adm_sec_server") }), _jsx(NavItem, { to: { page: "settings", section: "dhcp" }, route: route, icon: _jsx(Router, { size: 20 }), label: t("adm_sec_dhcp") }), _jsx(NavItem, { to: { page: "settings", section: "mirror" }, route: route, icon: _jsx(CloudDownload, { size: 20 }), label: t("adm_sec_mirror") }), _jsx(NavItem, { to: { page: "settings", section: "bootmenu" }, route: route, icon: _jsx(Languages, { size: 20 }), label: t("adm_sec_bootmenu") }), _jsx(NavItem, { to: { page: "settings", section: "defaults" }, route: route, icon: _jsx(HardDrive, { size: 20 }), label: t("adm_sec_defaults") }), _jsx(NavItem, { to: { page: "settings", section: "share" }, route: route, icon: _jsx(Share2, { size: 20 }), label: t("adm_sec_share") }), _jsx(NavItem, { to: { page: "settings", section: "zededa" }, route: route, icon: _jsx(CloudUpload, { size: 20 }), label: t("adm_sec_zededa") }), _jsx(NavItem, { to: { page: "settings", section: "access" }, route: route, icon: _jsx(ShieldCheck, { size: 20 }), label: t("adm_sec_access") })] }), _jsxs(NavGroup, { label: t("adm_nav_maintenance"), children: [_jsx(NavItem, { to: { page: "logs" }, route: route, icon: _jsx(ScrollText, { size: 20 }), label: t("adm_nav_logs") }), _jsx(NavItem, { to: { page: "updates" }, route: route, icon: _jsx(Download, { size: 20 }), label: t("adm_nav_updates") }), _jsx(NavItem, { to: { page: "backup" }, route: route, icon: _jsx(Archive, { size: 20 }), label: t("adm_nav_backup") }), _jsx(NavItem, { to: { page: "system" }, route: route, icon: _jsx(Wrench, { size: 20 }), label: t("adm_nav_system") })] })] }))] }), _jsx("div", { className: "side-foot", children: status?.config.version ? t("ui_version", { v: status.config.version }) : PRODUCT })] }), navOpen && _jsx("div", { className: "scrim", onClick: () => setNavOpen(false) }), _jsx("main", { className: "main", children: children })] }));
}
function sameRoute(a, b) {
    if (a.page !== b.page)
        return false;
    if (a.page === "settings" && b.page === "settings")
        return a.section === b.section;
    return true;
}
function UserMenu({ hostname, version, onLogout }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const close = (e) => {
            if (!ref.current?.contains(e.target))
                setOpen(false);
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);
    return (_jsxs("div", { className: "menu-wrap", ref: ref, children: [_jsx("button", { className: "avatar", "aria-label": t("adm_account"), "aria-expanded": open, onClick: () => setOpen(!open), children: "AD" }), open && (_jsxs("div", { className: "menu account", role: "menu", children: [_jsxs("div", { className: "account-head", children: [_jsx("span", { className: "avatar big", children: "AD" }), _jsxs("div", { children: [_jsx("strong", { children: "admin" }), _jsx("div", { className: "muted small", children: hostname })] })] }), _jsxs("a", { className: "menu-item", href: "#/system", onClick: () => setOpen(false), children: [_jsx(KeyRound, { size: 17 }), " ", _jsx("span", { children: t("adm_change_password") })] }), _jsxs("button", { className: "menu-item danger", onClick: () => { setOpen(false); onLogout?.(); }, children: [_jsx(LogOut, { size: 17 }), " ", _jsx("span", { children: t("adm_logout") })] }), _jsx("div", { className: "menu-foot", children: t("adm_appliance_version", { v: version }) })] }))] }));
}
function NavItem(props) {
    const active = sameRoute(props.to, props.route);
    return (_jsxs("a", { className: `nav-item${active ? " active" : ""}`, href: href(props.to), "aria-current": active ? "page" : undefined, children: [props.icon, _jsx("span", { children: props.label }), props.count !== undefined && _jsx("span", { className: "nav-count", children: props.count })] }));
}
function NavGroup({ label, children }) {
    const [open, setOpen] = useState(true);
    return (_jsxs("div", { className: "nav-group", children: [_jsxs("button", { className: "nav-group-head", onClick: () => setOpen(!open), "aria-expanded": open, children: [_jsx("span", { children: label }), _jsx(ChevronDown, { size: 16, className: open ? "" : "rot" })] }), open && children] }));
}
function ThemeMenu() {
    const t = useT();
    const [theme, setThemeState] = useState(getTheme);
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        const close = (e) => {
            if (!ref.current?.contains(e.target))
                setOpen(false);
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);
    const choose = (v) => {
        setTheme(v);
        setThemeState(v);
        setOpen(false);
    };
    const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
    const options = [
        ["light", Sun, t("ui_theme_light")],
        ["dark", Moon, t("ui_theme_dark")],
        ["system", Monitor, t("ui_theme_system")],
    ];
    return (_jsxs("div", { className: "menu-wrap", ref: ref, children: [_jsx("button", { className: "icon-btn", title: t("ui_theme"), "aria-label": t("ui_theme"), "aria-expanded": open, onClick: () => setOpen(!open), children: _jsx(Icon, { size: 19 }) }), open && (_jsxs("div", { className: "menu", role: "menu", children: [_jsx("div", { className: "menu-title", children: t("ui_theme") }), options.map(([v, I, label]) => (_jsxs("button", { role: "menuitemradio", "aria-checked": theme === v, className: `menu-item${theme === v ? " checked" : ""}`, onClick: () => choose(v), children: [_jsx(I, { size: 17 }), _jsx("span", { children: label })] }, v)))] }))] }));
}
