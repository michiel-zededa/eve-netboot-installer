import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CircleAlert, CircleCheck, CloudDownload, FolderInput, HardDrive, Loader, Moon } from "lucide-react";
import { DHCP_TEXT, dhcpMode, imageState, serverHost } from "../api";
import { Card, CopyField, Donut, PageHeader, StatCard } from "../components";
import { useT } from "../i18n";
export default function Home({ status, activity }) {
    const t = useT();
    const entries = status?.entries ?? [];
    const n = { ready: 0, not_netboot: 0, error: 0, github: 0, local: 0 };
    for (const e of entries) {
        n[imageState(e)]++;
        n[e.source]++;
    }
    const problems = n.not_netboot + n.error;
    const disk = activity?.disk;
    const host = serverHost(status?.config);
    return (_jsxs("div", { className: "page", children: [_jsx(PageHeader, { title: t("ui_home_title"), subtitle: t("ui_home_text") }), _jsxs("div", { className: "stat-grid", children: [_jsx(StatCard, { value: n.ready, label: t("ui_card_ready"), icon: _jsx(CircleCheck, { size: 20 }), tone: "ok", badge: entries.length ? `${Math.round((n.ready / entries.length) * 100)}%` : undefined, href: "#/images" }), _jsx(StatCard, { value: n.github, label: t("ui_card_github"), icon: _jsx(CloudDownload, { size: 20 }), href: "#/images/github" }), _jsx(StatCard, { value: n.local, label: t("ui_card_local"), icon: _jsx(FolderInput, { size: 20 }), href: "#/images/local" }), _jsx(StatCard, { value: problems, label: t("ui_card_problems"), icon: _jsx(CircleAlert, { size: 20 }), tone: problems ? "err" : undefined, href: "#/images" }), _jsx(StatCard, { value: disk ? `${disk.free_gb.toFixed(0)}` : "-", label: t("ui_card_disk"), icon: _jsx(HardDrive, { size: 20 }), badge: disk ? "GB" : undefined })] }), _jsxs("div", { className: "grid-3", children: [_jsxs(Card, { title: t("ui_image_health"), children: [_jsx(Donut, { parts: [
                                    { value: n.ready, tone: "ok" },
                                    { value: n.not_netboot, tone: "warn" },
                                    { value: n.error, tone: "err" },
                                ], center: `${n.ready}/${entries.length}`, sub: t("ui_card_ready") }), _jsxs("ul", { className: "legend", children: [_jsxs("li", { children: [_jsx("i", { className: "dot ok" }), t("ui_pill_ready"), " ", _jsx("b", { children: n.ready })] }), _jsxs("li", { children: [_jsx("i", { className: "dot warn" }), t("ui_pill_not_netboot"), " ", _jsx("b", { children: n.not_netboot })] }), _jsxs("li", { children: [_jsx("i", { className: "dot err" }), t("ui_pill_error"), " ", _jsx("b", { children: n.error })] })] })] }), _jsx(Card, { title: t("ui_activity"), children: _jsx(ActivityView, { activity: activity, status: status }) }), _jsxs(Card, { title: dhcpMode(status) === "off" ? t("ui_dhcp_title") : t("ui_dhcp_title_own"), children: [_jsx("p", { className: "muted small", children: t(DHCP_TEXT[dhcpMode(status)]) }), _jsx(CopyField, { label: t("ui_next_server"), value: host }), _jsx(CopyField, { label: t("ui_boot_file"), value: "eve-x86_64.efi", hint: t("ui_boot_file_x86") }), _jsx(CopyField, { label: t("ui_boot_file"), value: "eve-arm64.efi", hint: t("ui_boot_file_arm") }), _jsx("a", { className: "link small", href: "#/boot", children: t("ui_more_boot") })] })] })] }));
}
function ActivityView({ activity, status }) {
    const t = useT();
    const busy = activity && activity.state !== "idle";
    const cfg = status?.config;
    return (_jsxs("div", { className: "activity", children: [busy ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "activity-state", children: [_jsx(Loader, { size: 20, className: "spin" }), _jsx("strong", { children: activity.state === "downloading"
                                    ? t("ui_downloading", { item: activity.item ?? "" })
                                    : t("ui_importing", { item: activity.item ?? "" }) })] }), activity.percent !== undefined && (_jsxs(_Fragment, { children: [_jsx("div", { className: "progress", role: "progressbar", "aria-valuenow": activity.percent, "aria-valuemin": 0, "aria-valuemax": 100, children: _jsx("span", { style: { width: `${activity.percent}%` } }) }), _jsxs("div", { className: "muted small", children: [activity.done_mb, " / ", activity.total_mb, " MB (", activity.percent, "%)"] })] }))] })) : (_jsxs("div", { className: "activity-state", children: [_jsx(Moon, { size: 20 }), _jsx("strong", { children: t("ui_idle") })] })), _jsxs("ul", { className: "facts", children: [_jsx("li", { children: t("ui_last_check", { date: status?.github_checked ?? t("ui_never") }) }), activity?.next_github_check && _jsx("li", { children: t("ui_next_check", { date: activity.next_github_check }) }), cfg && (_jsxs("li", { children: [t("ui_mirror_text", { lines: cfg.lts_lines }), ": ", cfg.arches.join(", "), " \u00B7 ", cfg.flavours.join(", ")] }))] })] }));
}
