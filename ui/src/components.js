import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useT } from "./i18n";
export function PageHeader({ title, subtitle, children }) {
    return (_jsxs("div", { className: "page-head", children: [_jsxs("div", { children: [_jsx("h1", { children: title }), subtitle && _jsx("p", { children: subtitle })] }), children && _jsx("div", { className: "page-head-actions", children: children })] }));
}
/** Big-number tile, like ONLINE / SUSPECT / NODES in the ZEDEDA dashboard. */
export function StatCard(props) {
    const body = (_jsxs(_Fragment, { children: [_jsxs("div", { className: "stat-top", children: [_jsx("span", { className: `stat-icon ${props.tone ?? ""}`, children: props.icon }), props.badge && _jsx("span", { className: `stat-badge ${props.tone ?? ""}`, children: props.badge })] }), _jsx("div", { className: `stat-value ${props.tone ?? ""}`, children: props.value }), _jsx("div", { className: "stat-label", children: props.label }), _jsx("span", { className: "stat-ghost", "aria-hidden": true, children: props.icon })] }));
    return props.href ? _jsx("a", { className: "card stat", href: props.href, children: body }) : _jsx("div", { className: "card stat", children: body });
}
export function Card({ title, actions, children, className }) {
    return (_jsxs("section", { className: `card ${className ?? ""}`, children: [title && (_jsxs("div", { className: "card-head", children: [_jsx("h3", { children: title }), actions] })), _jsx("div", { className: "card-body", children: children })] }));
}
const PILL_TONE = { ready: "ok", not_netboot: "warn", error: "err" };
const PILL_KEY = {
    ready: "ui_pill_ready", not_netboot: "ui_pill_not_netboot", error: "ui_pill_error",
};
export function StatePill({ state }) {
    const t = useT();
    return _jsx("span", { className: `pill ${PILL_TONE[state]}`, children: t(PILL_KEY[state]) });
}
export function Pill({ tone, children }) {
    return _jsx("span", { className: `pill ${tone}`, children: children });
}
/** Ring chart with "ready/total" in the middle (FLEET HEALTH in the ZEDEDA UI). */
export function Donut({ parts, center, sub }) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    const r = 70;
    const c = 2 * Math.PI * r;
    const gap = total > 1 ? 4 : 0;
    let offset = 0;
    return (_jsxs("div", { className: "donut", children: [_jsxs("svg", { viewBox: "0 0 180 180", role: "img", "aria-label": `${center} ${sub}`, children: [_jsx("circle", { cx: "90", cy: "90", r: r, className: "donut-track" }), total > 0 &&
                        parts.filter((p) => p.value > 0).map((p, i) => {
                            const len = (p.value / total) * c;
                            const el = (_jsx("circle", { cx: "90", cy: "90", r: r, className: `donut-seg ${p.tone}`, strokeDasharray: `${Math.max(len - gap, 0.5)} ${c}`, strokeDashoffset: -offset, transform: "rotate(-90 90 90)" }, i));
                            offset += len;
                            return el;
                        })] }), _jsxs("div", { className: "donut-center", children: [_jsx("strong", { children: center }), _jsx("span", { children: sub })] })] }));
}
export function CopyField({ label, value, hint }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
        }
        catch {
            // http pages without clipboard access: select the text instead
            const range = document.createRange();
            const el = document.getElementById(`cf-${label}`);
            if (el) {
                range.selectNodeContents(el);
                getSelection()?.removeAllRanges();
                getSelection()?.addRange(range);
            }
            return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (_jsxs("div", { className: "copy-field", children: [_jsx("div", { className: "kv-label", children: label }), _jsxs("div", { className: "copy-row", children: [_jsx("code", { id: `cf-${label}`, children: value }), hint && _jsx("span", { className: "muted small", children: hint }), _jsx("button", { className: "icon-btn small", onClick: copy, title: t("ui_copy"), "aria-label": t("ui_copy"), children: copied ? _jsx(Check, { size: 16 }) : _jsx(Copy, { size: 16 }) })] })] }));
}
export function KeyValues({ rows }) {
    return (_jsx("dl", { className: "kv", children: rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (_jsxs("div", { className: "kv-row", children: [_jsx("dt", { children: k }), _jsx("dd", { children: v })] }, k))) }));
}
export function Drawer({ title, onClose, children }) {
    const t = useT();
    useEffect(() => {
        const onKey = (e) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "scrim drawer-scrim", onClick: onClose }), _jsxs("aside", { className: "drawer", role: "dialog", "aria-modal": "true", children: [_jsxs("div", { className: "drawer-head", children: [_jsx("h2", { children: title }), _jsx("button", { className: "icon-btn", onClick: onClose, "aria-label": t("ui_close"), children: _jsx(X, { size: 20 }) })] }), _jsx("div", { className: "drawer-body", children: children })] })] }));
}
export function Empty({ icon, text }) {
    return (_jsxs("div", { className: "empty", children: [icon, _jsx("p", { children: text })] }));
}
