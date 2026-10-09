import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FileUp, Languages, Loader } from "lucide-react";
import { api, waitJob, type SettingsInfo } from "../admin";
import { errorText, Fields, splitChanges, type Field, type Values } from "../forms";
import { PRODUCT, useT, type TFunc } from "../i18n";
import { SECTIONS, type SectionId } from "../sections";

// Web version of the console setup wizard, for VMs without a console. Open
// until the VM is set up (the owner's choice); then it is closed for good.
// The same steps as the console: language first, so that everything after it
// is in the chosen language.

const pick = (id: SectionId, keys: string[]) => (info: SettingsInfo | null, t: TFunc): Field[] =>
  SECTIONS.find((s) => s.id === id)!.fields(info, t).filter((f) => keys.includes(f.key));

const STEPS: { title: string; text: string; fields?: (info: SettingsInfo | null, t: TFunc) => Field[] }[] = [
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

export default function Setup({ onDone, onLanguage }: { onDone: () => void; onLanguage: (lang: string) => void }) {
  const t = useT();
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [step, setStep] = useState(0);
  const [v, setV] = useState<Values>({});
  const [pw, setPw] = useState({ a: "", b: "" });
  const [importUrl, setImportUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.settings().then(setInfo).catch((e) => setError(errorText(e)));
  }, []);

  const set = (k: string, val: string) => setV((x) => ({ ...x, [k]: val }));
  const all: Values = { ...(info?.defaults ?? {}), ...(info?.settings ?? {}), ...v };

  const setLanguage = (lang: string) => {
    set("ENI_LANGUAGE", lang);
    onLanguage(lang);
  };

  const canNext = () => {
    if (step === 1) return pw.a.length >= 8 && pw.a === pw.b;
    if (step === SHARE_STEP && all.SMB_IMPORT_SHARE === "yes") return (v.SMB_PASSWORD ?? "").length >= 8;
    return true;
  };

  const doImport = async (from: { url?: string; text?: string }) => {
    setError("");
    try {
      const { settings } = await api.importSettings(from);
      setV((x) => ({ ...settings, ...x }));
      if (settings.ENI_LANGUAGE && !v.ENI_LANGUAGE) onLanguage(settings.ENI_LANGUAGE);
      setStep(1);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const importFile = async (file: File) => {
    if (fileRef.current) fileRef.current.value = "";
    if (file.size > 256 * 1024) return setError(t("adm_imp_not_a_settings_file"));
    doImport({ text: await file.text() });
  };

  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      const { settings, secrets } = splitChanges(v);
      const { job } = await api.setup(settings, { ...secrets, ADMIN_PASSWORD: pw.a });
      const done = await waitJob(job, setMessages);
      if (done.state === "failed") throw new Error(done.messages.at(-1) ?? t("adm_failed"));
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const s = STEPS[step];
  const languages = info?.choices.languages ?? [["en", "English"]];
  return (
    <div className="center-page">
      <div className="card setup">
        <div className="setup-head">
          <span className="logo" />
          <span className="muted small">{t("adm_step", { n: step + 1, total: STEPS.length })}</span>
        </div>
        <div className="progress"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
        <h1>{step === 0 ? PRODUCT : t(s.title)}</h1>
        <p className="muted">{t(s.text)}</p>
        {error && <div className="alert err">{error}</div>}

        {step === 0 && (
          <div className="welcome">
            <label className="field-label" htmlFor="lang">{t("adm_language_text")}</label>
            <div className="lang-pick">
              <Languages size={20} />
              <select id="lang" value={all.ENI_LANGUAGE || "en"} onChange={(e) => setLanguage(e.target.value)}>
                {languages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </div>
            <button className="btn primary block" onClick={() => setStep(1)}>{t("adm_setup_new")}</button>
            <div className="divider"><span>{t("adm_setup_import_or")}</span></div>
            <label className="field-label" htmlFor="imp">{t("adm_imp_ask_url")}</label>
            <input id="imp" value={importUrl} onChange={(e) => setImportUrl(e.target.value)}
              placeholder="http://192.168.1.20:8080/export-3fa9c1.txt" />
            <button className="btn block" disabled={!importUrl} onClick={() => doImport({ url: importUrl })}>
              {t("adm_imp_check")}
            </button>
            <div className="file-pick">
              <input ref={fileRef} type="file" accept=".txt,.env,text/plain" hidden
                onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
              <button className="btn block" onClick={() => fileRef.current?.click()}>
                <FileUp size={16} /> {t("adm_imp_upload_file")}
              </button>
              <span className="muted small">{t("adm_imp_upload_help")}</span>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="fields">
            <div className="field"><label className="field-label" htmlFor="pa">{t("adm_pw_label", { n: 8 })}</label>
              <input id="pa" type="password" autoComplete="new-password" autoFocus value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></div>
            <div className="field"><label className="field-label" htmlFor="pb">{t("adm_pw_again_label")}</label>
              <input id="pb" type="password" autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} />
              {pw.b && pw.a !== pw.b && <div className="field-help err-text">{t("adm_pw_mismatch")}</div>}</div>
          </div>
        )}

        {s.fields && <Fields fields={s.fields(info, t)} v={v} info={info} set={set} />}

        {step === STEPS.length - 1 && (
          <dl className="kv">
            {([
              [t("adm_sec_network"), all.NET_MODE === "static" ? `${all.NET_ADDRESS} gw ${all.NET_GATEWAY || "-"} dns ${all.NET_DNS || "-"}` : "DHCP"],
              [t("adm_sec_server"), all.SERVER_IP === "auto" ? t("adm_this_vm", { ip: info?.network.primary_ip ?? "?" }) : all.SERVER_IP],
              [t("adm_sec_language"), languages.find(([c]) => c === all.ENI_LANGUAGE)?.[1] ?? all.ENI_LANGUAGE],
              [t("adm_sec_mirror"), t("adm_mirror_summary", { n: all.EVE_LTS_LINES, arches: all.EVE_ARCHES, flavours: all.EVE_FLAVOURS })],
              [t("adm_f_eve_default_install_server"), all.EVE_DEFAULT_INSTALL_SERVER || t("adm_p_eve_default_install_server")],
              [t("adm_f_eve_default_serial"), all.EVE_DEFAULT_SERIAL && all.EVE_DEFAULT_SERIAL !== "none"
                ? all.EVE_DEFAULT_SERIAL : t("adm_o_eve_default_serial_none")],
              [t("adm_sec_share"), all.SMB_IMPORT_SHARE === "yes" ? t("adm_on") : t("adm_off")],
            ] as [string, string][]).map(([k, val]) => (
              <div className="kv-row" key={k}><dt>{k}</dt><dd>{val}</dd></div>
            ))}
          </dl>
        )}

        {busy && (
          <div className="job running">
            <Loader size={16} className="spin" /> {messages.at(-1) ?? t("adm_applying_text")}
          </div>
        )}

        {step > 0 && (
          <div className="form-actions">
            <button className="btn" disabled={busy} onClick={() => setStep(step - 1)}><ArrowLeft size={16} /> {t("adm_btn_back")}</button>
            <span className="spacer" />
            {step < STEPS.length - 1 ? (
              <button className="btn primary" disabled={!canNext()} onClick={() => setStep(step + 1)}>{t("adm_btn_next")} <ArrowRight size={16} /></button>
            ) : (
              <button className="btn primary" disabled={busy} onClick={apply}><Check size={16} /> {t("adm_apply_start")}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
