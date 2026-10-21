import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileUp, KeyRound, Power, RefreshCw, RotateCcw, Upload } from "lucide-react";
import { api, waitJob } from "../admin";
import { Card, PageHeader } from "../components";
import { Confirm, errorText, RollbackDialog, SaveStatus, SECRET_FIELDS, useSaver, useToast, } from "../forms";
import { PRODUCT, useT } from "../i18n";
// ---------------------------------------------------------------------------
export function Logs() {
    const t = useT();
    const [source, setSource] = useState("sync");
    const [lines, setLines] = useState(300);
    const [text, setText] = useState("");
    const [auto, setAuto] = useState(true);
    const load = useCallback(() => {
        api.logs(source, lines).then(setText).catch((e) => setText(errorText(e)));
    }, [source, lines]);
    useEffect(() => {
        load();
        if (!auto)
            return;
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
    }, [load, auto]);
    const sources = ["sync", "tftp", "web", "dhcp", "appliance", "system"].map((v) => [v, t(`adm_o_log_${v}`)]);
    return (_jsxs("div", { className: "page", children: [_jsx(PageHeader, { title: t("adm_nav_logs"), subtitle: t("adm_logs_subtitle") }), _jsx("div", { className: "tabs", children: sources.map(([v, l]) => (_jsx("button", { className: `tab${source === v ? " active" : ""}`, onClick: () => setSource(v), children: l }, v))) }), _jsxs("div", { className: "toolbar", children: [_jsx("select", { value: lines, onChange: (e) => setLines(Number(e.target.value)), "aria-label": t("adm_lines_label"), children: [100, 300, 1000, 5000].map((n) => _jsx("option", { value: n, children: t("adm_lines", { n }) }, n)) }), _jsxs("label", { className: "check", children: [_jsx("input", { type: "checkbox", checked: auto, onChange: (e) => setAuto(e.target.checked) }), " ", t("adm_auto_refresh")] }), _jsx("div", { className: "toolbar-right", children: _jsxs("button", { className: "btn slim", onClick: load, children: [_jsx(RefreshCw, { size: 16 }), " ", t("ui_refresh")] }) })] }), _jsx("pre", { className: "card log", children: text || " " })] }));
}
// ---------------------------------------------------------------------------
function JobView({ job }) {
    if (!job)
        return null;
    const p = job.progress;
    return (_jsxs("div", { className: `job ${job.state}`, children: [p && job.state === "running" && (_jsxs("div", { className: "job-progress", children: [_jsxs("div", { className: "job-progress-head", children: [_jsx("strong", { children: job.messages.at(-1) }), _jsxs("span", { className: "muted", children: [Math.round(p.percent), "%"] })] }), _jsx("div", { className: "progress", children: _jsx("span", { style: { width: `${p.percent}%` } }) }), _jsx("div", { className: "muted small job-detail", children: p.detail || "\u00a0" })] })), (p && job.state === "running" ? job.messages.slice(0, -1) : job.messages).map((m, i) => (_jsx("div", { className: p && job.state === "running" ? "muted" : undefined, children: m }, i))), job.state === "running" && !p && _jsx("div", { className: "muted", children: "..." })] }));
}
export function Updates({ info }) {
    const t = useT();
    const toast = useToast();
    const [job, setJob] = useState(null);
    const [ask, setAsk] = useState("");
    const run = async (name) => {
        try {
            const { job: id } = await api.action(name);
            const done = await waitJob(id, (_messages, current) => setJob(current));
            setJob(done);
            const result = done.result;
            if (result?.message)
                setJob({ ...done, messages: [...done.messages, result.message] });
            // a job can finish without updating (already current, a development build)
            const ok = done.state === "done" && result?.ok !== false;
            toast(ok ? t("adm_update_finished") : result?.message ?? t("adm_update_failed"), ok ? "ok" : "err");
            if (result?.reboot)
                setAsk("reboot");
        }
        catch (e) {
            toast(errorText(e), "err");
        }
    };
    return (_jsxs("div", { className: "page", children: [_jsx(PageHeader, { title: t("adm_nav_updates"), subtitle: t("adm_updates_subtitle") }), _jsxs("div", { className: "grid-2", children: [_jsxs(Card, { title: t("adm_updates_system_title"), children: [_jsx("p", { children: t("adm_updates_system_text") }), _jsx("p", { className: "muted small", children: t("adm_snapshot_tip") }), _jsxs("button", { className: "btn primary", disabled: job?.state === "running", onClick: () => setAsk("update-system"), children: [_jsx(Download, { size: 16 }), " ", t("adm_update_system")] })] }), _jsxs(Card, { title: PRODUCT, children: [_jsx("p", { children: t("adm_updates_app_text") }), _jsxs("p", { className: "muted small", children: [t("adm_now_running"), " ", _jsx("code", { children: info?.image ?? "..." })] }), _jsxs("button", { className: "btn primary", disabled: job?.state === "running", onClick: () => setAsk("update-app"), children: [_jsx(Download, { size: 16 }), " ", t("adm_update_app")] })] })] }), job && _jsx(Card, { title: t("adm_progress"), children: _jsx(JobView, { job: job }) }), (ask === "update-system" || ask === "update-app") && (_jsx(Confirm, { title: t("adm_btn_update"), text: ask === "update-system" ? t("adm_update_system_confirm")
                    : t("adm_update_app_confirm"), confirm: t("adm_btn_update"), onConfirm: () => run(ask), onClose: () => setAsk("") })), ask === "reboot" && (_jsx(Confirm, { title: t("adm_reboot_needed"), text: t("adm_reboot_needed_text"), confirm: t("adm_btn_reboot"), onConfirm: () => api.action("reboot").then(() => toast(t("adm_rebooting"))), onClose: () => setAsk("") }))] }));
}
// ---------------------------------------------------------------------------
export function Backup({ onSaved }) {
    const t = useT();
    const toast = useToast();
    const [exported, setExported] = useState("");
    const [url, setUrl] = useState("");
    const [text, setText] = useState("");
    const [file, setFile] = useState("");
    const fileRef = useRef(null);
    const [preview, setPreview] = useState(null);
    const { state, save, reset } = useSaver(() => {
        toast(t("adm_imported_applied"));
        onSaved?.();
    });
    useEffect(() => {
        fetch("api/export", { credentials: "same-origin" }).then((r) => r.text()).then(setExported).catch(() => { });
    }, []);
    // an exported settings file of another VM (eve-netboot-settings.txt)
    const pickFile = async (f) => {
        if (fileRef.current)
            fileRef.current.value = "";
        if (f.size > 256 * 1024)
            return toast(t("adm_imp_not_a_settings_file"), "err");
        setUrl("");
        setFile(f.name);
        const content = await f.text();
        setText(content);
        load({ text: content });
    };
    const load = async (from = url ? { url } : { text }) => {
        try {
            const [{ settings }, current] = await Promise.all([api.importSettings(from), api.settings()]);
            const changes = {};
            for (const [k, v] of Object.entries(settings)) {
                if (!SECRET_FIELDS.has(k) && current.settings[k] !== v)
                    changes[k] = v;
            }
            setPreview({ changes, current: current.settings });
        }
        catch (e) {
            toast(errorText(e), "err");
        }
    };
    return (_jsxs("div", { className: "page", children: [_jsx(PageHeader, { title: t("adm_nav_backup"), subtitle: t("adm_backup_subtitle") }), _jsxs("div", { className: "grid-2", children: [_jsxs(Card, { title: t("adm_export"), children: [_jsx("p", { children: t("adm_export_text") }), _jsxs("a", { className: "btn primary", href: "api/export", download: true, children: [_jsx(Download, { size: 16 }), " ", t("adm_download")] }), _jsx("pre", { className: "log small-log", children: exported })] }), _jsxs(Card, { title: t("adm_import"), children: [_jsx("label", { className: "field-label", children: t("adm_imp_file_label") }), _jsxs("div", { className: "file-pick", children: [_jsx("input", { ref: fileRef, type: "file", accept: ".txt,.env,text/plain", hidden: true, onChange: (e) => e.target.files?.[0] && pickFile(e.target.files[0]) }), _jsxs("button", { className: "btn", onClick: () => fileRef.current?.click(), children: [_jsx(FileUp, { size: 16 }), " ", t("adm_imp_upload_file")] }), file && _jsx("span", { className: "muted small", children: file })] }), _jsx("label", { className: "field-label", htmlFor: "imp-url", children: t("adm_imp_or_url") }), _jsx("input", { id: "imp-url", value: url, onChange: (e) => { setUrl(e.target.value); setFile(""); }, placeholder: "http://192.168.1.20:8080/export-3fa9c1.txt" }), _jsx("label", { className: "field-label", htmlFor: "imp-text", children: t("adm_imp_or_paste") }), _jsx("textarea", { id: "imp-text", rows: 6, value: text, onChange: (e) => { setText(e.target.value); setFile(""); }, placeholder: "ENI_LANGUAGE=en" }), _jsxs("button", { className: "btn", disabled: !url && !text, onClick: () => load(), children: [_jsx(Upload, { size: 16 }), " ", t("adm_imp_check")] }), preview && (_jsx("div", { className: "preview", children: Object.keys(preview.changes).length === 0 ? _jsx("p", { children: t("adm_imp_nothing") }) : (_jsxs(_Fragment, { children: [_jsxs("table", { className: "table compact", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: t("adm_col_setting") }), _jsx("th", { children: t("adm_col_now") }), _jsx("th", { children: t("adm_col_imported") })] }) }), _jsx("tbody", { children: Object.entries(preview.changes).map(([k, v]) => (_jsxs("tr", { children: [_jsx("td", { children: _jsx("code", { children: k }) }), _jsx("td", { children: preview.current[k] ?? "—" }), _jsx("td", { children: v })] }, k))) })] }), _jsxs("div", { className: "form-actions", children: [_jsx("button", { className: "btn primary", disabled: state.phase === "saving", onClick: () => save(preview.changes), children: t("adm_imp_apply") }), _jsx(SaveStatus, { state: state })] })] })) }))] })] }), state.phase === "rollback" && _jsx(RollbackDialog, { result: state.result, onClose: reset })] }));
}
// ---------------------------------------------------------------------------
export function System() {
    const t = useT();
    const toast = useToast();
    const [ask, setAsk] = useState("");
    const [pw, setPw] = useState({ current: "", next: "", again: "" });
    const changePassword = async () => {
        if (pw.next !== pw.again)
            return toast(t("adm_pw_mismatch"), "err");
        try {
            await api.password(pw.current, pw.next);
            setPw({ current: "", next: "", again: "" });
            toast(t("adm_password_changed"));
        }
        catch (e) {
            toast(errorText(e), "err");
        }
    };
    return (_jsxs("div", { className: "page", children: [_jsx(PageHeader, { title: t("adm_nav_system"), subtitle: t("adm_system_subtitle") }), _jsxs("div", { className: "grid-2", children: [_jsxs(Card, { title: t("adm_admin_password"), children: [_jsx("p", { className: "muted small", children: t("adm_setup_password_text") }), _jsxs("div", { className: "fields", children: [_jsxs("div", { className: "field", children: [_jsx("label", { className: "field-label", htmlFor: "pw-c", children: t("adm_pw_current") }), _jsx("input", { id: "pw-c", type: "password", autoComplete: "current-password", value: pw.current, onChange: (e) => setPw({ ...pw, current: e.target.value }) })] }), _jsxs("div", { className: "field", children: [_jsx("label", { className: "field-label", htmlFor: "pw-n", children: t("adm_pw_label", { n: 8 }) }), _jsx("input", { id: "pw-n", type: "password", autoComplete: "new-password", value: pw.next, onChange: (e) => setPw({ ...pw, next: e.target.value }) })] }), _jsxs("div", { className: "field", children: [_jsx("label", { className: "field-label", htmlFor: "pw-a", children: t("adm_pw_again_label") }), _jsx("input", { id: "pw-a", type: "password", autoComplete: "new-password", value: pw.again, onChange: (e) => setPw({ ...pw, again: e.target.value }) })] })] }), _jsxs("button", { className: "btn primary", disabled: !pw.current || pw.next.length < 8, onClick: changePassword, children: [_jsx(KeyRound, { size: 16 }), " ", t("adm_change_password")] })] }), _jsxs(Card, { title: t("adm_mirror_card"), children: [_jsx("p", { children: t("adm_sync_text") }), _jsxs("button", { className: "btn", onClick: () => api.action("sync").then(() => toast(t("adm_sync_started")))
                                    .catch((e) => toast(errorText(e), "err")), children: [_jsx(RefreshCw, { size: 16 }), " ", t("adm_sync_now")] })] }), _jsxs(Card, { title: t("adm_diagnostics"), children: [_jsx("p", { children: t("adm_diagnostics_text") }), _jsxs("a", { className: "btn", href: "api/diagnostics", download: true, children: [_jsx(Download, { size: 16 }), " ", t("adm_diagnostics_download")] })] }), _jsxs(Card, { title: t("adm_power"), children: [_jsx("p", { children: t("adm_power_text") }), _jsxs("div", { className: "form-actions", children: [_jsxs("button", { className: "btn", onClick: () => setAsk("reboot"), children: [_jsx(RotateCcw, { size: 16 }), " ", t("adm_reboot")] }), _jsxs("button", { className: "btn danger", onClick: () => setAsk("poweroff"), children: [_jsx(Power, { size: 16 }), " ", t("adm_poweroff")] })] })] })] }), ask && (_jsx(Confirm, { title: ask === "reboot" ? t("adm_reboot") : t("adm_poweroff"), danger: ask === "poweroff", text: ask === "reboot" ? t("adm_reboot_web_q") : t("adm_poweroff_q"), confirm: ask === "reboot" ? t("adm_reboot") : t("adm_poweroff"), onConfirm: () => api.action(ask).then(() => toast(ask === "reboot" ? t("adm_rebooting") : t("adm_powering_off")))
                    .catch((e) => toast(errorText(e), "err")), onClose: () => setAsk("") }))] }));
}
