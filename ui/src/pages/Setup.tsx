import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader } from "lucide-react";
import { api, waitJob, type SettingsInfo } from "../admin";
import { errorText, Fields, splitChanges, type Field, type Values } from "../forms";
import { SECTIONS } from "../sections";

// Web version of the console setup wizard, for VMs without a console. Open
// until the VM is set up (the owner's choice); then it is closed for good.

const pick = (id: string, keys: string[]) => (info: SettingsInfo | null): Field[] =>
  SECTIONS.find((s) => s.id === id)!.fields(info).filter((f) => keys.includes(f.key));

const STEPS: { title: string; text: string; fields?: (info: SettingsInfo | null) => Field[] }[] = [
  { title: "Welcome", text: "This VM is a network boot (PXE) server for LF Edge EVE-OS installers. A few questions and it is ready." },
  { title: "Admin password", text: "For this web page, the VM's screen and SSH (user admin)." },
  { title: "Network", text: "How this VM gets its IP address.", fields: pick("network", ["NET_MODE", "NET_ADDRESS", "NET_GATEWAY", "NET_DNS", "NET_INTERFACE"]) },
  { title: "Server address", text: "The address PXE clients use to reach this VM.", fields: pick("server", ["SERVER_IP"]) },
  { title: "Boot menu", text: "Language of the boot menu and the status page.", fields: pick("bootmenu", ["ENI_LANGUAGE"]) },
  { title: "What to mirror", text: "Which EVE-OS releases to download from GitHub.", fields: pick("mirror", ["EVE_ARCHES", "EVE_FLAVOURS", "EVE_LTS_LINES"]) },
  { title: "Installer defaults", text: "Pre-filled in the boot menu.", fields: pick("defaults", ["EVE_DEFAULT_INSTALL_SERVER", "EVE_DEFAULT_SERIAL"]) },
  { title: "Import share", text: "Copy your own installer ISOs to the VM from Windows or macOS (you can also upload them in this web UI).", fields: pick("share", ["SMB_IMPORT_SHARE", "SMB_PASSWORD"]) },
  { title: "Ready", text: "Check the summary and apply." },
];

export default function Setup({ onDone }: { onDone: () => void }) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [step, setStep] = useState(0);
  const [v, setV] = useState<Values>({});
  const [pw, setPw] = useState({ a: "", b: "" });
  const [importUrl, setImportUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then(setInfo).catch((e) => setError(errorText(e)));
  }, []);

  const set = (k: string, val: string) => setV((x) => ({ ...x, [k]: val }));
  const all: Values = { ...(info?.defaults ?? {}), ...(info?.settings ?? {}), ...v };

  const canNext = () => {
    if (step === 1) return pw.a.length >= 8 && pw.a === pw.b;
    if (step === 7 && all.SMB_IMPORT_SHARE === "yes") return (v.SMB_PASSWORD ?? "").length >= 8;
    return true;
  };

  const doImport = async () => {
    setError("");
    try {
      const { settings } = await api.importSettings({ url: importUrl });
      setV((x) => ({ ...settings, ...x }));
      setStep(1);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      const { settings, secrets } = splitChanges(v);
      const { job } = await api.setup(settings, { ...secrets, ADMIN_PASSWORD: pw.a });
      const done = await waitJob(job, setMessages);
      if (done.state === "failed") throw new Error(done.messages.at(-1) ?? "The setup failed.");
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const s = STEPS[step];
  return (
    <div className="center-page">
      <div className="card setup">
        <div className="setup-head">
          <span className="logo" />
          <span className="muted small">Step {step + 1} of {STEPS.length}</span>
        </div>
        <div className="progress"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
        <h1>{s.title}</h1>
        <p className="muted">{s.text}</p>
        {error && <div className="alert err">{error}</div>}

        {step === 0 && (
          <div className="welcome">
            <button className="btn primary block" onClick={() => setStep(1)}>Set up this VM</button>
            <div className="divider"><span>or import the settings of another EVE-Netboot VM</span></div>
            <label className="field-label" htmlFor="imp">Address shown by "Export settings" on the other VM</label>
            <input id="imp" value={importUrl} onChange={(e) => setImportUrl(e.target.value)}
              placeholder="http://192.168.1.20:8080/export-3fa9c1.txt" />
            <button className="btn block" disabled={!importUrl} onClick={doImport}>Import and check the settings</button>
          </div>
        )}

        {step === 1 && (
          <div className="fields">
            <div className="field"><label className="field-label" htmlFor="pa">Password (at least 8 characters)</label>
              <input id="pa" type="password" autoComplete="new-password" autoFocus value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></div>
            <div className="field"><label className="field-label" htmlFor="pb">Password again</label>
              <input id="pb" type="password" autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} />
              {pw.b && pw.a !== pw.b && <div className="field-help err-text">The passwords do not match.</div>}</div>
          </div>
        )}

        {s.fields && <Fields fields={s.fields(info)} v={v} info={info} set={set} />}

        {step === STEPS.length - 1 && (
          <dl className="kv">
            {([
              ["Network", all.NET_MODE === "static" ? `${all.NET_ADDRESS} gw ${all.NET_GATEWAY || "-"} dns ${all.NET_DNS || "-"}` : "DHCP"],
              ["Server address", all.SERVER_IP === "auto" ? `this VM (${info?.network.primary_ip ?? "?"})` : all.SERVER_IP],
              ["Language", info?.choices.languages.find(([c]) => c === all.ENI_LANGUAGE)?.[1] ?? all.ENI_LANGUAGE],
              ["Mirror", `${all.EVE_LTS_LINES} LTS lines, ${all.EVE_ARCHES}, ${all.EVE_FLAVOURS}`],
              ["Controller", all.EVE_DEFAULT_INSTALL_SERVER || "from the ISO"],
              ["Serial console", all.EVE_DEFAULT_SERIAL || "none"],
              ["Import share", all.SMB_IMPORT_SHARE === "yes" ? "yes" : "no"],
            ] as [string, string][]).map(([k, val]) => (
              <div className="kv-row" key={k}><dt>{k}</dt><dd>{val}</dd></div>
            ))}
          </dl>
        )}

        {busy && (
          <div className="job running">
            <Loader size={16} className="spin" /> {messages.at(-1) ?? "Applying the settings and starting the services. The first start takes up to a minute ..."}
          </div>
        )}

        {step > 0 && (
          <div className="form-actions">
            <button className="btn" disabled={busy} onClick={() => setStep(step - 1)}><ArrowLeft size={16} /> Back</button>
            <span className="spacer" />
            {step < STEPS.length - 1 ? (
              <button className="btn primary" disabled={!canNext()} onClick={() => setStep(step + 1)}>Next <ArrowRight size={16} /></button>
            ) : (
              <button className="btn primary" disabled={busy} onClick={apply}><Check size={16} /> Apply and start</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
