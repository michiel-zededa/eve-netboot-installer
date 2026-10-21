import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// The ZEDEDA session of the onboarding: log in with an API (or session) token,
// or with the user's password (used once, never kept). The appliance keeps the token in
// memory only; after a restart or when it expires, log in again.
import { useEffect, useRef, useState } from "react";
import { BrushCleaning, Download, FileDown, FileUp, ListX, LogIn, LogOut, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../admin";
import { Card } from "../components";
import { Confirm, errorText, useToast } from "../forms";
import { useT } from "../i18n";
const time = (s) => (s ? new Date(s * 1000).toLocaleString() : "?");
// today: only the time; otherwise date and time
const when = (s) => {
    if (!s)
        return "-";
    const d = new Date(s * 1000);
    return d.toDateString() === new Date().toDateString()
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
};
// a node this VM created (or found) in ZEDEDA and still there: it can be deleted there
const inZededa = (n) => (n.result === "created" || n.result === "exists") && Boolean(n.node_id) && n.status?.state !== "gone";
// entries that only clutter the list: failed, deleted, or no longer in ZEDEDA
const stale = (n) => n.result === "failed" || n.result === "deleted" || n.status?.state === "gone";
const STATE_TONE = {
    online: "ok", starting: "info", waiting: "warn", offline: "warn", error: "err", gone: "err",
    noread: "neutral", unknown: "neutral",
};
export default function ZededaSession() {
    const t = useT();
    const [info, setInfo] = useState(null);
    const [password, setPassword] = useState("");
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [warning, setWarning] = useState("");
    // what to confirm: delete in ZEDEDA, or remove from the list (this VM only)
    const [ask, setAsk] = useState(null);
    const [selected, setSelected] = useState(new Set());
    const fileRef = useRef(null);
    const machinesRef = useRef(null);
    const [machinesError, setMachinesError] = useState("");
    const [askClear, setAskClear] = useState(false);
    const toast = useToast();
    // with a ZEDEDA session also the state of the nodes (did the machines come online?)
    const load = (force = false) => api.zededa()
        .then((i) => (i.session ? api.zededaStatus(force) : i))
        .then(setInfo)
        .catch((e) => setError(errorText(e)));
    useEffect(() => {
        load();
        const timer = setInterval(() => load(), 30000); // the list fills while machines install and boot
        return () => clearInterval(timer);
    }, []);
    const login = async (by) => {
        setBusy(true);
        setError("");
        setWarning("");
        try {
            const r = await api.zededaLogin(by);
            setInfo(r);
            setWarning(r.warning);
            load(true); // the nodes' state, now that ZEDEDA can be asked
        }
        catch (e) {
            setError(errorText(e));
        }
        finally {
            setPassword("");
            setToken("");
            setBusy(false);
        }
    };
    const logout = async () => {
        setBusy(true);
        try {
            await api.zededaLogout();
            await load();
        }
        finally {
            setBusy(false);
        }
    };
    const run = async ({ action, nodes }) => {
        const macs = nodes.map((n) => n.mac);
        try {
            if (action === "delete") {
                const r = await api.zededaDelete(macs);
                if (r.deleted.length) {
                    toast(r.deleted.length === 1 ? t("adm_zo_deleted", { name: r.deleted[0] })
                        : t("adm_zo_deleted_many", { n: r.deleted.length }));
                }
                if (r.failed.length) {
                    toast(t("adm_zo_delete_some_failed", { list: r.failed.map((f) => `${f.name}: ${f.error}`).join("; ") }), "err");
                }
            }
            else {
                const r = await api.zededaForget(macs);
                toast(t("adm_zo_forgotten", { n: r.removed }));
            }
        }
        catch (e) {
            toast(errorText(e), "err");
        }
        setSelected(new Set());
        load();
    };
    const importList = async (file) => {
        if (fileRef.current)
            fileRef.current.value = "";
        if (file.size > 1024 * 1024)
            return toast(t("adm_zo_not_csv"), "err");
        try {
            const r = await api.zededaImport(await file.text());
            toast(t("adm_zo_imported", { n: r.imported, skipped: r.skipped }));
            load(true);
        }
        catch (e) {
            toast(errorText(e), "err");
        }
    };
    // the machine list: an upload replaces it (every row must be valid), or clear it
    const uploadMachines = async (file) => {
        if (machinesRef.current)
            machinesRef.current.value = "";
        setMachinesError("");
        if (file.size > 1024 * 1024)
            return setMachinesError(t("adm_ml_bad_header"));
        try {
            const r = await api.zededaMachines({ text: await file.text() });
            setInfo((i) => (i ? { ...i, machines: r.machines } : r));
            toast(t("adm_ml_uploaded", { n: r.count ?? r.machines.length }));
        }
        catch (e) {
            setMachinesError(errorText(e));
        }
    };
    const clearMachines = async () => {
        try {
            const r = await api.zededaMachines({ clear: true });
            setInfo((i) => (i ? { ...i, machines: r.machines } : r));
            toast(t("adm_ml_cleared"));
        }
        catch (e) {
            toast(errorText(e), "err");
        }
    };
    if (!info)
        return error ? _jsx("div", { className: "alert err", children: error }) : null;
    if (!info.enabled)
        return null;
    const s = info.session;
    // the machines that should be in ZEDEDA (not failed, not deleted there)
    const nodes = info.onboarded.filter((n) => (n.result === "created" || n.result === "exists") && n.status?.state !== "gone");
    const chosen = info.onboarded.filter((n) => selected.has(n.mac));
    const deletable = chosen.filter(inZededa);
    const clutter = info.onboarded.filter(stale);
    const toggle = (mac) => setSelected((s) => {
        const x = new Set(s);
        if (x.has(mac))
            x.delete(mac);
        else
            x.add(mac);
        return x;
    });
    const all = info.onboarded.length > 0 && chosen.length === info.onboarded.length;
    const online = nodes.filter((n) => n.status?.state === "online").length;
    // the login method of the settings: an API token needs nothing else, a password the
    // user and enterprise from the settings
    const withPassword = info.login === "password";
    return (_jsxs(_Fragment, { children: [_jsxs(Card, { title: t("adm_zo_session"), children: [error && _jsxs("div", { className: "alert err", children: [_jsx(TriangleAlert, { size: 16 }), " ", error] }), warning && _jsxs("div", { className: "alert warn", children: [_jsx(TriangleAlert, { size: 16 }), " ", warning] }), s ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "session-row", children: [_jsxs("p", { children: [_jsx("span", { className: "pill ok", children: t("adm_zo_logged_in") }), " ", s.via === "token"
                                                ? t(s.user && s.enterprise ? "adm_zo_session_token_text"
                                                    : s.user ? "adm_zo_session_token_user" : "adm_zo_session_token_anon", { user: s.user, enterprise: s.enterprise, cluster: s.cluster })
                                                : t("adm_zo_session_text", { user: s.user, enterprise: s.enterprise, cluster: s.cluster,
                                                    until: time(s.expires) })] }), _jsxs("button", { className: "btn slim", disabled: busy, onClick: logout, children: [_jsx(LogOut, { size: 16 }), " ", t("adm_zo_logout")] })] }), _jsx("p", { className: "muted small", children: t("adm_zo_memory_note") })] })) : (_jsxs(_Fragment, { children: [_jsx("p", { children: _jsx("span", { className: "pill warn", children: t("adm_zo_not_logged_in_ui") }) }), withPassword ? (_jsx("p", { className: "muted small", children: t("adm_zo_login_text", { user: info.user || "-", enterprise: info.enterprise || "-",
                                    cluster: info.cluster }) })) : (_jsx("p", { className: "muted small", children: t("adm_zo_login_token_text", { cluster: info.cluster }) })), _jsx("div", { className: "fields", children: withPassword ? (_jsxs("label", { className: "field", children: [_jsx("span", { className: "field-label", children: t("adm_zo_password") }), _jsx("input", { type: "password", autoComplete: "off", value: password, onChange: (e) => setPassword(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && password)
                                                login({ password }); } })] })) : (_jsxs("label", { className: "field", children: [_jsx("span", { className: "field-label", children: t("adm_zo_token") }), _jsx("input", { type: "password", autoComplete: "off", value: token, onChange: (e) => setToken(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && token)
                                                login({ token }); } }), _jsx("span", { className: "field-help", children: t("adm_zo_token_help") })] })) }), _jsx("div", { className: "form-actions", children: _jsxs("button", { className: "btn primary", disabled: busy || (withPassword ? !password : !token), onClick: () => login(withPassword ? { password } : { token }), children: [_jsx(LogIn, { size: 16 }), " ", t("adm_zo_login")] }) }), _jsx("p", { className: "muted small", children: t("adm_zo_user_hint") })] }))] }), _jsxs(Card, { title: t("adm_ml_title"), actions: _jsxs("div", { className: "card-actions", children: [_jsxs("a", { className: "btn slim", href: "api/zededa/machines-template.csv", download: true, children: [_jsx(FileDown, { size: 16 }), " ", t("adm_ml_template")] }), _jsxs("button", { className: "btn slim", onClick: () => machinesRef.current?.click(), children: [_jsx(FileUp, { size: 16 }), " ", t("adm_ml_upload")] }), _jsx("input", { ref: machinesRef, type: "file", accept: ".csv,text/csv", hidden: true, onChange: (e) => e.target.files?.[0] && uploadMachines(e.target.files[0]) }), info.machines.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("a", { className: "btn slim", href: "api/zededa/machines.csv", download: true, children: [_jsx(Download, { size: 16 }), " ", t("adm_ml_download")] }), _jsxs("button", { className: "btn slim", onClick: () => setAskClear(true), children: [_jsx(ListX, { size: 16 }), " ", t("adm_ml_clear")] })] }))] }), children: [_jsx("p", { className: "muted small", children: t("adm_ml_text") }), machinesError && _jsxs("div", { className: "alert err multiline", children: [_jsx(TriangleAlert, { size: 16 }), " ", _jsx("span", { children: machinesError })] }), info.machines.length === 0 ? (_jsx("p", { className: "muted", children: t("adm_ml_none") })) : (_jsx("div", { className: "table-card", children: _jsxs("table", { className: "table compact", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: t("adm_zo_col_name") }), _jsx("th", { children: t("adm_zo_col_mac") }), _jsx("th", { children: t("adm_ml_col_serial") }), _jsx("th", { children: t("adm_ml_col_project") }), _jsx("th", { children: t("adm_ml_col_installed") })] }) }), _jsx("tbody", { children: info.machines.map((m) => (_jsxs("tr", { children: [_jsx("td", { className: "nowrap", children: m.name ? _jsx("strong", { children: m.name }) : _jsx("span", { className: "muted", children: t("ob_name_auto") }) }), _jsx("td", { className: "mono nowrap", children: m.mac || "-" }), _jsx("td", { className: "mono", children: m.hardware_serial || "-" }), _jsx("td", { children: m.project || _jsx("span", { className: "muted", children: info.project }) }), _jsx("td", { children: m.node ? (_jsx("span", { className: `pill ${m.node.result === "failed" ? "err" : STATE_TONE[m.node.state] ?? "ok"}`, children: m.node.result === "failed" || !m.node.state ? t(`adm_zo_result_${m.node.result}`)
                                                        : t(`adm_zo_state_${m.node.state}`) })) : (_jsx("span", { className: "muted", children: t("adm_ml_not_yet") })) })] }, m.mac || m.hardware_serial))) })] }) }))] }), _jsxs(Card, { title: t("adm_zo_onboarded"), actions: _jsxs("div", { className: "card-actions", children: [s && info.onboarded.length > 0 && (_jsxs("button", { className: "btn slim", onClick: () => load(true), children: [_jsx(RefreshCw, { size: 16 }), " ", t("adm_zo_check_now")] })), _jsxs("button", { className: "btn slim", title: t("adm_zo_import_help"), onClick: () => fileRef.current?.click(), children: [_jsx(FileUp, { size: 16 }), " ", t("adm_zo_import_csv")] }), _jsx("input", { ref: fileRef, type: "file", accept: ".csv,text/csv", hidden: true, onChange: (e) => e.target.files?.[0] && importList(e.target.files[0]) }), info.onboarded.length > 0 && (_jsxs("a", { className: "btn slim", href: "api/zededa/export", download: true, children: [_jsx(Download, { size: 16 }), " ", t("adm_zo_export_csv")] }))] }), children: [nodes.length > 0 && (_jsx("p", { children: _jsx("span", { className: `pill ${online === nodes.length ? "ok" : "warn"}`, children: t("adm_zo_summary", { online, total: nodes.length }) }) })), nodes.some((n) => n.status?.state === "waiting") && _jsx("p", { className: "muted small", children: t("adm_zo_waiting_hint") }), (chosen.length > 0 || clutter.length > 0) && (_jsx("div", { className: "selection-bar", children: chosen.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "muted small", children: t("adm_zo_selected", { n: chosen.length }) }), _jsxs("button", { className: "btn slim", onClick: () => setAsk({ action: "forget", nodes: chosen }), children: [_jsx(ListX, { size: 16 }), " ", t("adm_zo_forget")] }), _jsxs("button", { className: "btn slim danger", disabled: !s || deletable.length === 0, title: s ? undefined : t("adm_zo_delete_login"), onClick: () => setAsk({ action: "delete", nodes: deletable }), children: [_jsx(Trash2, { size: 16 }), " ", t("adm_zo_delete"), deletable.length !== chosen.length ? ` (${deletable.length})` : ""] })] })) : (_jsxs("button", { className: "btn slim", title: t("adm_zo_cleanup_help"), onClick: () => setAsk({ action: "forget", nodes: clutter }), children: [_jsx(BrushCleaning, { size: 16 }), " ", t("adm_zo_cleanup", { n: clutter.length })] })) })), info.onboarded.length === 0 ? (_jsx("p", { className: "muted", children: t("adm_zo_none_yet") })) : (_jsx("div", { className: "table-card", children: _jsxs("table", { className: "table compact", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: "select", children: _jsx("input", { type: "checkbox", "aria-label": t("adm_zo_select_all"), checked: all, onChange: () => setSelected(all ? new Set() : new Set(info.onboarded.map((n) => n.mac))) }) }), _jsx("th", { children: t("adm_zo_col_time") }), _jsx("th", { children: t("adm_zo_col_name") }), _jsx("th", { children: t("adm_zo_col_mac") }), _jsx("th", { children: t("adm_zo_col_machine") }), _jsx("th", { children: t("adm_zo_col_state") }), _jsx("th", {})] }) }), _jsx("tbody", { children: info.onboarded.map((n) => (_jsxs("tr", { className: selected.has(n.mac) ? "selected" : undefined, children: [_jsx("td", { className: "select", children: _jsx("input", { type: "checkbox", "aria-label": n.name, checked: selected.has(n.mac), onChange: () => toggle(n.mac) }) }), _jsx("td", { className: "nowrap", children: when(n.time) }), _jsx("td", { className: "nowrap", children: _jsx("strong", { children: n.name }) }), _jsx("td", { className: "mono nowrap", children: n.mac }), _jsxs("td", { children: [n.product || "-", n.hardware_serial && _jsx("div", { className: "small muted mono", children: n.hardware_serial })] }), _jsxs("td", { children: [n.result === "failed" || n.result === "deleted" || !n.status ? (_jsx("span", { className: `pill ${n.result === "failed" ? "err" : n.result === "deleted" ? "neutral" : "ok"}`, children: t(`adm_zo_result_${n.result}`) })) : (_jsx("span", { className: `pill ${STATE_TONE[n.status.state]}`, title: n.status.run_state ?? "", children: t(`adm_zo_state_${n.status.state}`) })), n.result === "failed" && _jsx("div", { className: "small err-text", children: n.message }), n.result !== "failed" && n.result !== "deleted" && (_jsxs(_Fragment, { children: [(n.online_since || n.status?.eve) && (_jsx("div", { className: "small muted", children: [n.online_since ? `${t("adm_zo_online_since")} ${when(n.online_since)}` : "",
                                                                    n.status?.eve ? `${t("adm_zo_eve_version")} ${n.status.eve}` : ""].filter(Boolean).join(" · ") })), n.status?.error && _jsx("div", { className: "small err-text", children: n.status.error })] }))] }), _jsxs("td", { className: "nowrap", children: [_jsx("button", { className: "icon-btn small", title: t("adm_zo_forget"), "aria-label": t("adm_zo_forget"), onClick: () => setAsk({ action: "forget", nodes: [n] }), children: _jsx(ListX, { size: 16 }) }), inZededa(n) && (_jsx("button", { className: "icon-btn small", title: s ? t("adm_zo_delete") : t("adm_zo_delete_login"), "aria-label": t("adm_zo_delete"), disabled: !s, onClick: () => setAsk({ action: "delete", nodes: [n] }), children: _jsx(Trash2, { size: 16 }) }))] })] }, n.mac))) })] }) }))] }), askClear && (_jsx(Confirm, { title: t("adm_ml_clear"), text: t("adm_ml_clear_q", { n: info.machines.length }), confirm: t("adm_ml_clear"), onConfirm: clearMachines, onClose: () => setAskClear(false) })), ask && (_jsx(Confirm, { danger: ask.action === "delete", title: ask.action === "delete" ? t("adm_zo_delete") : t("adm_zo_forget"), text: ask.action === "delete"
                    ? (ask.nodes.length === 1 ? t("adm_zo_delete_q", { name: ask.nodes[0].name })
                        : t("adm_zo_delete_many_q", { n: ask.nodes.length,
                            names: ask.nodes.map((n) => n.name).join(", ") }))
                    : t("adm_zo_forget_q", { n: ask.nodes.length, names: ask.nodes.map((n) => n.name).join(", ") }), confirm: ask.action === "delete" ? t("adm_zo_delete") : t("adm_zo_forget"), onConfirm: () => run(ask), onClose: () => setAsk(null) }))] }));
}
