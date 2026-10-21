import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Loader, X } from "lucide-react";
import { api, ApiError, waitJob } from "./admin";
import { useT } from "./i18n";
export function value(v, info, key) {
    return v[key] ?? info?.settings[key] ?? info?.defaults[key] ?? "";
}
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export function FieldInput({ field, v, info, set }) {
    const t = useT();
    const val = value(v, info, field.key);
    const id = `f-${field.key}`;
    let control;
    switch (field.type) {
        case "select":
            control = (_jsx("select", { id: id, value: val, onChange: (e) => set(field.key, e.target.value), children: (field.options ?? []).map(([o, l]) => _jsx("option", { value: o, children: l }, o)) }));
            break;
        case "yesno":
        case "onezero": {
            const [on, off] = field.type === "yesno" ? ["yes", "no"] : ["1", "0"];
            control = (_jsxs("label", { className: "switch", children: [_jsx("input", { id: id, type: "checkbox", checked: val === on, onChange: (e) => set(field.key, e.target.checked ? on : off) }), _jsx("span", { className: "switch-track" }), _jsx("span", { children: val === on ? t("adm_on") : t("adm_off") })] }));
            break;
        }
        case "checks": {
            const chosen = val.split(/\s+/).filter(Boolean);
            control = (_jsx("div", { className: "checks", children: (field.options ?? []).map(([o, l]) => (_jsxs("label", { className: "check", children: [_jsx("input", { type: "checkbox", checked: chosen.includes(o), onChange: (e) => set(field.key, (e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o))
                                .sort((a, b) => (field.options ?? []).findIndex(([x]) => x === a) - (field.options ?? []).findIndex(([x]) => x === b))
                                .join(" ")) }), _jsx("span", { children: l })] }, o))) }));
            break;
        }
        case "textarea":
            // stored as "a; b" (one line in settings.env), edited one per line
            control = _jsx("textarea", { id: id, rows: 4, value: val.split(/;\s*/).join("\n"), placeholder: field.placeholder, onChange: (e) => set(field.key, e.target.value.split("\n").join("; ")) });
            break;
        case "secret":
            control = _jsx("input", { id: id, type: "password", autoComplete: "new-password", value: v[field.key] ?? "", placeholder: field.placeholder, onChange: (e) => set(field.key, e.target.value) });
            break;
        default:
            control = _jsx("input", { id: id, type: field.type === "number" ? "number" : "text", value: val, placeholder: field.placeholder, onChange: (e) => set(field.key, e.target.value) });
    }
    return (_jsxs("div", { className: `field${field.wide ? " wide" : ""}`, children: [_jsx("label", { htmlFor: id, className: "field-label", children: field.label }), control, field.help && _jsx("div", { className: "field-help", children: field.help })] }));
}
export function Fields({ fields, v, info, set }) {
    const all = { ...(info?.defaults ?? {}), ...(info?.settings ?? {}), ...v };
    return (_jsx("div", { className: "fields", children: fields.filter((f) => !f.showIf || f.showIf(all)).map((f) => (_jsx(FieldInput, { field: f, v: v, info: info, set: set }, f.key))) }));
}
// ---------------------------------------------------------------------------
// Saving: background task, progress, network rollback
// ---------------------------------------------------------------------------
export const SECRET_FIELDS = new Set(["ADMIN_PASSWORD", "SMB_PASSWORD", "ENI_GITHUB_TOKEN"]);
export function splitChanges(changes) {
    const settings = {};
    const secrets = {};
    for (const [k, v] of Object.entries(changes)) {
        if (SECRET_FIELDS.has(k)) {
            if (v)
                secrets[k] = v;
        }
        else {
            settings[k] = v === "" ? null : v;
        }
    }
    return { settings, secrets };
}
export function useSaver(onDone) {
    const t = useT();
    const [state, setState] = useState({ phase: "idle" });
    const save = async (changes) => {
        const { settings, secrets } = splitChanges(changes);
        setState({ phase: "saving", messages: [] });
        try {
            const result = await api.save(settings, secrets);
            if (result.rollback) {
                // the address may change: the job result may never reach this page
                setState({ phase: "rollback", result });
                return;
            }
            const job = await waitJob(result.job, (messages) => setState({ phase: "saving", messages }));
            if (job.state === "failed")
                throw new Error(job.messages.at(-1) ?? t("adm_failed"));
            setState({ phase: "done", message: t("adm_saved") });
            onDone?.();
        }
        catch (e) {
            setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
        }
    };
    return { state, save, reset: () => setState({ phase: "idle" }) };
}
export function SaveStatus({ state }) {
    const t = useT();
    if (state.phase === "saving") {
        return _jsxs("span", { className: "save-status", children: [_jsx(Loader, { size: 16, className: "spin" }), " ", state.messages.at(-1) ?? t("adm_saving")] });
    }
    if (state.phase === "done")
        return _jsxs("span", { className: "save-status ok", children: [_jsx(CircleCheck, { size: 16 }), " ", state.message] });
    if (state.phase === "error")
        return _jsxs("span", { className: "save-status err", children: [_jsx(CircleAlert, { size: 16 }), " ", state.message] });
    return null;
}
export function RollbackDialog({ result, onClose }) {
    const t = useT();
    const rb = result.rollback;
    const [left, setLeft] = useState(rb.seconds);
    const [confirmed, setConfirmed] = useState(false);
    useEffect(() => {
        const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
        return () => clearInterval(t);
    }, []);
    // same address (e.g. only the DNS changed): confirm from here
    const confirmHere = async () => {
        try {
            await api.confirmNetwork(rb.token);
            setConfirmed(true);
        }
        catch (e) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };
    return (_jsx(Modal, { title: t("adm_rb_title"), onClose: onClose, children: confirmed ? (_jsx("p", { children: t("adm_rb_kept") })) : (_jsxs(_Fragment, { children: [_jsx("p", { children: t("adm_rb_text", { seconds: left }) }), rb.confirm_url ? (_jsxs("p", { children: [t("adm_rb_open_new"), _jsx("br", {}), _jsx("a", { className: "btn primary", href: rb.confirm_url, children: rb.confirm_url.split("#")[0] })] })) : (_jsx("p", { children: t("adm_rb_dhcp") })), _jsx("p", { className: "muted small", children: t("adm_rb_still_here") }), _jsx("button", { className: "btn", onClick: confirmHere, children: t("adm_rb_keep") })] })) }));
}
// ---------------------------------------------------------------------------
// Modal and toast
// ---------------------------------------------------------------------------
export function Modal({ title, onClose, children, actions }) {
    const t = useT();
    useEffect(() => {
        const onKey = (e) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (_jsxs("div", { className: "modal-wrap", role: "dialog", "aria-modal": "true", children: [_jsx("div", { className: "scrim drawer-scrim", onClick: onClose }), _jsxs("div", { className: "modal", children: [_jsxs("div", { className: "drawer-head", children: [_jsx("h2", { children: title }), _jsx("button", { className: "icon-btn", onClick: onClose, "aria-label": t("ui_close"), children: _jsx(X, { size: 20 }) })] }), _jsx("div", { className: "modal-body", children: children }), actions && _jsx("div", { className: "modal-actions", children: actions })] })] }));
}
export function Confirm({ title, text, confirm, danger, onConfirm, onClose }) {
    const t = useT();
    return (_jsx(Modal, { title: title, onClose: onClose, actions: _jsxs(_Fragment, { children: [_jsx("button", { className: "btn", onClick: onClose, children: t("adm_btn_cancel") }), _jsx("button", { className: `btn ${danger ? "danger" : "primary"}`, onClick: () => { onConfirm(); onClose(); }, children: confirm })] }), children: text }));
}
const ToastContext = createContext(() => { });
export const useToast = () => useContext(ToastContext);
export function ToastHost({ children }) {
    const [toasts, setToasts] = useState([]);
    const push = (text, tone = "ok") => {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t, { id, text, tone }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    };
    return (_jsxs(ToastContext.Provider, { value: push, children: [children, _jsx("div", { className: "toasts", "aria-live": "polite", children: toasts.map((t) => (_jsxs("div", { className: `toast ${t.tone}`, children: [t.tone === "ok" ? _jsx(CircleCheck, { size: 18 }) : _jsx(CircleAlert, { size: 18 }), " ", t.text] }, t.id))) })] }));
}
export function errorText(e) {
    if (e instanceof ApiError || e instanceof Error)
        return e.message;
    return String(e);
}
