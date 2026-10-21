import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FileUp, Languages, Loader } from "lucide-react";
import { api, waitJob } from "../admin";
import { errorText, Fields, splitChanges } from "../forms";
import { PRODUCT, useT } from "../i18n";
import { SECTIONS } from "../sections";
// Web version of the console setup wizard, for VMs without a console. Open
// until the VM is set up (the owner's choice); then it is closed for good.
// The same steps as the console: language first, so that everything after it
// is in the chosen language.
const pick = (id, keys) => (info, t) => SECTIONS.find((s) => s.id === id).fields(info, t).filter((f) => keys.includes(f.key));
const STEPS = [
    { title: "adm_welcome", text: "adm_welcome_text" },
    { title: "adm_admin_password", text: "adm_setup_password_text" },
    { title: "adm_sec_network", text: "adm_sec_network_text",
        fields: pick("network", ["NET_MODE", "NET_ADDRESS", "NET_GATEWAY", "NET_DNS", "NET_INTERFACE"]) },
    { title: "adm_sec_server", text: "adm_sec_server_text", fields: pick("server", ["SERVER_IP"]) },
    { title: "adm_sec_mirror", text: "adm_sec_mirror_text", fields: pick("mirror", ["EVE_ARCHES", "EVE_FLAVOURS", "EVE_LTS_LINES"]) },
    { title: "adm_sec_defaults", text: "adm_setup_defaults_text",
        fields: pick("defaults", ["EVE_DEFAULT_INSTALL_SERVER", "EVE_DEFAULT_SERIAL"]) },
    { title: "adm_sec_share", text: "adm_sec_share_text", fields: pick("share", ["SMB_IMPORT_SHARE", "SMB_PASSWORD"]) },
    { title: "adm_ready", text: "adm_setup_ready_text" },
];
const SHARE_STEP = 6;
export default function Setup({ onDone, onLanguage }) {
    const t = useT();
    const [info, setInfo] = useState(null);
    const [step, setStep] = useState(0);
    const [v, setV] = useState({});
    const [pw, setPw] = useState({ a: "", b: "" });
    const [importUrl, setImportUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [messages, setMessages] = useState([]);
    const [error, setError] = useState("");
    const fileRef = useRef(null);
    useEffect(() => {
        api.settings().then(setInfo).catch((e) => setError(errorText(e)));
    }, []);
    const set = (k, val) => setV((x) => ({ ...x, [k]: val }));
    const all = { ...(info?.defaults ?? {}), ...(info?.settings ?? {}), ...v };
    const setLanguage = (lang) => {
        set("ENI_LANGUAGE", lang);
        onLanguage(lang);
    };
    const canNext = () => {
        if (step === 1)
            return pw.a.length >= 8 && pw.a === pw.b;
        if (step === SHARE_STEP && all.SMB_IMPORT_SHARE === "yes")
            return (v.SMB_PASSWORD ?? "").length >= 8;
        return true;
    };
    const doImport = async (from) => {
        setError("");
        try {
            const { settings } = await api.importSettings(from);
            setV((x) => ({ ...settings, ...x }));
            if (settings.ENI_LANGUAGE && !v.ENI_LANGUAGE)
                onLanguage(settings.ENI_LANGUAGE);
            setStep(1);
        }
        catch (e) {
            setError(errorText(e));
        }
    };
    const importFile = async (file) => {
        if (fileRef.current)
            fileRef.current.value = "";
        if (file.size > 256 * 1024)
            return setError(t("adm_imp_not_a_settings_file"));
        doImport({ text: await file.text() });
    };
    const apply = async () => {
        setBusy(true);
        setError("");
        try {
            const { settings, secrets } = splitChanges(v);
            const { job } = await api.setup(settings, { ...secrets, ADMIN_PASSWORD: pw.a });
            const done = await waitJob(job, setMessages);
            if (done.state === "failed")
                throw new Error(done.messages.at(-1) ?? t("adm_failed"));
            onDone();
        }
        catch (e) {
            setError(errorText(e));
            setBusy(false);
        }
    };
    const s = STEPS[step];
    const languages = info?.choices.languages ?? [["en", "English"]];
    return (_jsx("div", { className: "center-page", children: _jsxs("div", { className: "card setup", children: [_jsxs("div", { className: "setup-head", children: [_jsx("span", { className: "logo" }), _jsx("span", { className: "muted small", children: t("adm_step", { n: step + 1, total: STEPS.length }) })] }), _jsx("div", { className: "progress", children: _jsx("span", { style: { width: `${((step + 1) / STEPS.length) * 100}%` } }) }), _jsx("h1", { children: step === 0 ? PRODUCT : t(s.title) }), _jsx("p", { className: "muted", children: t(s.text) }), error && _jsx("div", { className: "alert err", children: error }), step === 0 && (_jsxs("div", { className: "welcome", children: [_jsx("label", { className: "field-label", htmlFor: "lang", children: t("adm_language_text") }), _jsxs("div", { className: "lang-pick", children: [_jsx(Languages, { size: 20 }), _jsx("select", { id: "lang", value: all.ENI_LANGUAGE || "en", onChange: (e) => setLanguage(e.target.value), children: languages.map(([code, name]) => _jsx("option", { value: code, children: name }, code)) })] }), _jsx("button", { className: "btn primary block", onClick: () => setStep(1), children: t("adm_setup_new") }), _jsx("div", { className: "divider", children: _jsx("span", { children: t("adm_setup_import_or") }) }), _jsx("label", { className: "field-label", htmlFor: "imp", children: t("adm_imp_ask_url") }), _jsx("input", { id: "imp", value: importUrl, onChange: (e) => setImportUrl(e.target.value), placeholder: "http://192.168.1.20:8080/export-3fa9c1.txt" }), _jsx("button", { className: "btn block", disabled: !importUrl, onClick: () => doImport({ url: importUrl }), children: t("adm_imp_check") }), _jsxs("div", { className: "file-pick", children: [_jsx("input", { ref: fileRef, type: "file", accept: ".txt,.env,text/plain", hidden: true, onChange: (e) => e.target.files?.[0] && importFile(e.target.files[0]) }), _jsxs("button", { className: "btn block", onClick: () => fileRef.current?.click(), children: [_jsx(FileUp, { size: 16 }), " ", t("adm_imp_upload_file")] }), _jsx("span", { className: "muted small", children: t("adm_imp_upload_help") })] })] })), step === 1 && (_jsxs("div", { className: "fields", children: [_jsxs("div", { className: "field", children: [_jsx("label", { className: "field-label", htmlFor: "pa", children: t("adm_pw_label", { n: 8 }) }), _jsx("input", { id: "pa", type: "password", autoComplete: "new-password", autoFocus: true, value: pw.a, onChange: (e) => setPw({ ...pw, a: e.target.value }) })] }), _jsxs("div", { className: "field", children: [_jsx("label", { className: "field-label", htmlFor: "pb", children: t("adm_pw_again_label") }), _jsx("input", { id: "pb", type: "password", autoComplete: "new-password", value: pw.b, onChange: (e) => setPw({ ...pw, b: e.target.value }) }), pw.b && pw.a !== pw.b && _jsx("div", { className: "field-help err-text", children: t("adm_pw_mismatch") })] })] })), s.fields && _jsx(Fields, { fields: s.fields(info, t), v: v, info: info, set: set }), step === STEPS.length - 1 && (_jsx("dl", { className: "kv", children: [
                        [t("adm_sec_network"), all.NET_MODE === "static" ? `${all.NET_ADDRESS} gw ${all.NET_GATEWAY || "-"} dns ${all.NET_DNS || "-"}` : "DHCP"],
                        [t("adm_sec_server"), all.SERVER_IP === "auto" ? t("adm_this_vm", { ip: info?.network.primary_ip ?? "?" }) : all.SERVER_IP],
                        [t("adm_sec_language"), languages.find(([c]) => c === all.ENI_LANGUAGE)?.[1] ?? all.ENI_LANGUAGE],
                        [t("adm_sec_mirror"), t("adm_mirror_summary", { n: all.EVE_LTS_LINES, arches: all.EVE_ARCHES, flavours: all.EVE_FLAVOURS })],
                        [t("adm_f_eve_default_install_server"), all.EVE_DEFAULT_INSTALL_SERVER || t("adm_p_eve_default_install_server")],
                        [t("adm_f_eve_default_serial"), all.EVE_DEFAULT_SERIAL && all.EVE_DEFAULT_SERIAL !== "none"
                                ? all.EVE_DEFAULT_SERIAL : t("adm_o_eve_default_serial_none")],
                        [t("adm_sec_share"), all.SMB_IMPORT_SHARE === "yes" ? t("adm_on") : t("adm_off")],
                    ].map(([k, val]) => (_jsxs("div", { className: "kv-row", children: [_jsx("dt", { children: k }), _jsx("dd", { children: val })] }, k))) })), busy && (_jsxs("div", { className: "job running", children: [_jsx(Loader, { size: 16, className: "spin" }), " ", messages.at(-1) ?? t("adm_applying_text")] })), step > 0 && (_jsxs("div", { className: "form-actions", children: [_jsxs("button", { className: "btn", disabled: busy, onClick: () => setStep(step - 1), children: [_jsx(ArrowLeft, { size: 16 }), " ", t("adm_btn_back")] }), _jsx("span", { className: "spacer" }), step < STEPS.length - 1 ? (_jsxs("button", { className: "btn primary", disabled: !canNext(), onClick: () => setStep(step + 1), children: [t("adm_btn_next"), " ", _jsx(ArrowRight, { size: 16 })] })) : (_jsxs("button", { className: "btn primary", disabled: busy, onClick: apply, children: [_jsx(Check, { size: 16 }), " ", t("adm_apply_start")] }))] }))] }) }));
}
