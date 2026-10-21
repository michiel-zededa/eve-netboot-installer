import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CloudDownload, ExternalLink, FolderInput, Layers, Search, Trash2, Upload, X } from "lucide-react";
import { ApiError, api, uploadIso } from "../admin";
import { Confirm, errorText, useToast } from "../forms";
import { formatSize, imageDate, imageFile, imageName, imageState, } from "../api";
import { href } from "../App";
import { Drawer, Empty, KeyValues, PageHeader, Pill, StatePill } from "../components";
import { useT } from "../i18n";
const STATE_ORDER = { error: 0, not_netboot: 1, ready: 2 };
export default function Images({ status, activity, tab, search, onSearch, admin, onChanged }) {
    const t = useT();
    const toast = useToast();
    const fileRef = useRef(null);
    const [upload, setUpload] = useState(null);
    const [overwrite, setOverwrite] = useState(null);
    const doUpload = async (file, replace = false) => {
        setUpload({ name: file.name, pct: 0 });
        try {
            await uploadIso(file, replace, (pct) => setUpload({ name: file.name, pct }), t("adm_api_interrupted"));
            toast(t("adm_uploaded", { file: file.name }));
            onChanged?.();
        }
        catch (e) {
            if (e instanceof ApiError && e.status === 409)
                setOverwrite(file);
            else
                toast(errorText(e), "err");
        }
        finally {
            setUpload(null);
            if (fileRef.current)
                fileRef.current.value = "";
        }
    };
    const [arch, setArch] = useState("");
    const [variant, setVariant] = useState("");
    const [sort, setSort] = useState({ key: "date", desc: true });
    const [selected, setSelected] = useState(null);
    const entries = status?.entries ?? [];
    const arches = [...new Set(entries.map((e) => e.arch).filter(Boolean))];
    const variants = [...new Set(entries.map((e) => e.variant).filter(Boolean))];
    const rows = useMemo(() => {
        const q = search.trim().toLowerCase();
        const list = entries.filter((e) => (tab === "all" || e.source === tab) &&
            (!arch || e.arch === arch) &&
            (!variant || e.variant === variant) &&
            (!q || [imageName(e), e.file, e.arch, e.variant, e.source, e.error].join(" ").toLowerCase().includes(q)));
        const val = (e) => {
            switch (sort.key) {
                case "name": return imageName(e).toLowerCase();
                case "source": return e.source;
                case "status": return STATE_ORDER[imageState(e)];
                case "arch": return e.arch ?? "";
                case "variant": return e.variant ?? "";
                case "size": return e.iso_size ?? 0;
                case "date": return imageDate(e);
            }
        };
        return [...list].sort((a, b) => {
            const x = val(a), y = val(b);
            const c = x < y ? -1 : x > y ? 1 : 0;
            return sort.desc ? -c : c;
        });
    }, [entries, tab, arch, variant, search, sort]);
    const current = entries.find((e) => e.path === selected) ?? null;
    const title = t("ui_section_images");
    const folder = status?.config.import_label || t("import_folder");
    const Th = ({ k, label }) => (_jsx("th", { "aria-sort": sort.key === k ? (sort.desc ? "descending" : "ascending") : "none", children: _jsxs("button", { onClick: () => setSort({ key: k, desc: sort.key === k ? !sort.desc : false }), children: [label, sort.key === k ? (sort.desc ? _jsx(ArrowDown, { size: 14 }) : _jsx(ArrowUp, { size: 14 })) : _jsx("span", { className: "sort-ph" })] }) }));
    return (_jsxs("div", { className: "page", children: [_jsx(PageHeader, { title: title, subtitle: t("ui_images_text"), children: admin && (_jsxs(_Fragment, { children: [_jsx("input", { ref: fileRef, type: "file", accept: ".iso", hidden: true, onChange: (e) => e.target.files?.[0] && doUpload(e.target.files[0]) }), _jsxs("button", { className: "btn primary slim", disabled: !!upload, onClick: () => fileRef.current?.click(), children: [_jsx(Upload, { size: 16 }), " ", t("adm_upload_iso")] })] })) }), upload && (_jsxs("div", { className: "notice upload", children: [_jsx("span", { children: t("adm_uploading", { file: upload.name, pct: upload.pct }) }), _jsx("div", { className: "progress", children: _jsx("span", { style: { width: `${upload.pct}%` } }) })] })), overwrite && (_jsx(Confirm, { title: t("adm_file_exists"), text: t("adm_file_exists_q", { file: overwrite.name }), confirm: t("adm_replace"), onConfirm: () => doUpload(overwrite, true), onClose: () => setOverwrite(null) })), _jsx("div", { className: "tabs", role: "tablist", children: ["all", "github", "local"].map((v) => (_jsx("a", { role: "tab", "aria-selected": tab === v, className: `tab${tab === v ? " active" : ""}`, href: href({ page: "images", tab: v }), children: v === "all" ? t("ui_nav_all") : v === "github" ? t("ui_nav_github") : t("ui_nav_local") }, v))) }), activity && activity.state !== "idle" && (_jsxs("div", { className: "notice", children: [_jsx(Pill, { tone: "info", children: activity.percent !== undefined ? `${activity.percent}%` : "…" }), activity.state === "downloading"
                        ? t("ui_downloading", { item: activity.item ?? "" })
                        : t("ui_importing", { item: activity.item ?? "" })] })), _jsxs("div", { className: "toolbar", children: [search && (_jsxs("button", { className: "chip", onClick: () => onSearch(""), children: [_jsx(Search, { size: 14 }), " \u201C", search, "\u201D ", _jsx(X, { size: 14 })] })), _jsx("span", { className: "muted", children: rows.length === 1 ? t("ui_count_image") : t("ui_count_images", { n: rows.length }) }), _jsxs("div", { className: "toolbar-right", children: [_jsxs("select", { value: arch, onChange: (e) => setArch(e.target.value), "aria-label": t("th_arch"), children: [_jsx("option", { value: "", children: t("ui_filter_all_arches") }), arches.map((a) => _jsx("option", { children: a }, a))] }), _jsxs("select", { value: variant, onChange: (e) => setVariant(e.target.value), "aria-label": t("th_variant"), children: [_jsx("option", { value: "", children: t("ui_filter_all_variants") }), variants.map((v) => _jsx("option", { children: v }, v))] })] })] }), rows.length === 0 ? (_jsx("div", { className: "card", children: _jsx(Empty, { icon: tab === "local" ? _jsx(FolderInput, { size: 32 }) : tab === "github" ? _jsx(CloudDownload, { size: 32 }) : _jsx(Layers, { size: 32 }), text: search || arch || variant ? t("ui_no_match")
                        : tab === "local" ? t("ui_empty_local", { folder }) : t("ui_empty_github") }) })) : (_jsx("div", { className: "card table-card", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx(Th, { k: "name", label: t("ui_col_name") }), _jsx(Th, { k: "source", label: t("th_source") }), _jsx(Th, { k: "status", label: t("th_status") }), _jsx(Th, { k: "arch", label: t("th_arch") }), _jsx(Th, { k: "variant", label: t("th_variant") }), _jsx(Th, { k: "size", label: t("ui_col_size") }), _jsx("th", { children: "SHA256" }), _jsx(Th, { k: "date", label: t("ui_col_date") })] }) }), _jsx("tbody", { children: rows.map((e) => (_jsxs("tr", { onClick: () => setSelected(e.path), tabIndex: 0, onKeyDown: (ev) => ev.key === "Enter" && setSelected(e.path), children: [_jsx("td", { children: _jsxs("span", { className: "name-cell", children: [_jsx("span", { className: "row-icon", children: e.source === "github" ? _jsx(CloudDownload, { size: 16 }) : _jsx(FolderInput, { size: 16 }) }), _jsxs("span", { className: "name-text", children: [_jsx("span", { className: "link", children: imageName(e) }), imageFile(e) && _jsx("span", { className: "muted small file-name", children: imageFile(e) })] })] }) }), _jsx("td", { children: e.source === "github" ? "GitHub" : t("ui_src_local") }), _jsx("td", { children: _jsx(StatePill, { state: imageState(e) }) }), _jsx("td", { children: e.arch ?? "—" }), _jsx("td", { children: e.variant || "—" }), _jsx("td", { className: "num", children: formatSize(e.iso_size) || "—" }), _jsx("td", { children: e.error ? "—" : e.sha256_verified ? _jsx(Pill, { tone: "ok", children: t("sha_verified") })
                                            : e.sha256 ? _jsx(Pill, { tone: "neutral", children: t("sha_computed") }) : "—" }), _jsx("td", { className: "num", children: imageDate(e) || "—" })] }, e.path))) })] }) })), current && _jsx(ImageDetail, { entry: current, admin: admin, onClose: () => setSelected(null), onDeleted: () => { setSelected(null); onChanged?.(); } })] }));
}
function ImageDetail({ entry: e, admin, onClose, onDeleted }) {
    const t = useT();
    const toast = useToast();
    const [ask, setAsk] = useState(false);
    const remove = () => api.deleteImage(e.file ?? "")
        .then(() => { toast(t("adm_deleted", { file: e.file ?? "" })); onDeleted(); })
        .catch((err) => toast(errorText(err), "err"));
    const yesNo = (v) => (v === undefined || v === null ? "" : v ? t("ui_yes") : t("ui_no"));
    return (_jsxs(Drawer, { title: _jsxs(_Fragment, { children: [imageName(e), " ", _jsx(StatePill, { state: imageState(e) })] }), onClose: onClose, children: [e.error && _jsx("div", { className: "alert err", children: e.error }), !e.error && !e.netboot_ok && _jsx("div", { className: "alert warn", children: t("err_netboot_1") }), _jsx(KeyValues, { rows: [
                    [t("th_source"), e.source === "github" ? "GitHub" : t("ui_src_local")],
                    [t("ui_detail_file"), e.source === "local" ? _jsx("code", { className: "mono break", children: e.file }) : null],
                    [t("th_arch"), e.arch],
                    [t("th_variant"), e.variant],
                    [t("ui_col_size"), formatSize(e.iso_size)],
                    [e.source === "github" ? t("ui_detail_published") : t("ui_detail_modified"), imageDate(e)],
                    [t("ui_detail_prepared"), e.prepared?.replace("T", " ")],
                    [t("ui_detail_ucode"), yesNo(e.ucode)],
                    [t("ui_detail_config_img"), yesNo(e.config_img)],
                    ["SHA256", e.sha256 ? (_jsxs("span", { className: "mono break", children: [e.sha256, " ", _jsx("br", {}), _jsx("span", { className: "muted small", children: e.sha256_verified ? t("ui_detail_sha_verified") : t("ui_detail_sha_computed") })] })) : null],
                    [t("ui_detail_console"), e.console ? _jsx("code", { className: "mono", children: e.console }) : null],
                    [t("ui_detail_kernel_args"), e.args ? _jsx("code", { className: "mono break block", children: e.args }) : null],
                ] }), _jsxs("div", { className: "form-actions", children: [!e.error && (_jsxs("a", { className: "btn", href: `eve/${e.path}/`, target: "_blank", rel: "noreferrer", children: [_jsx(ExternalLink, { size: 16 }), " ", t("ui_open_files")] })), admin && e.source === "local" && e.file && (_jsxs("button", { className: "btn danger", onClick: () => setAsk(true), children: [_jsx(Trash2, { size: 16 }), " ", t("adm_delete_iso")] }))] }), ask && (_jsx(Confirm, { title: t("adm_delete_iso_title"), danger: true, confirm: t("adm_delete"), onConfirm: remove, onClose: () => setAsk(false), text: t("adm_delete_iso_q", { file: e.file ?? "" }) }))] }));
}
