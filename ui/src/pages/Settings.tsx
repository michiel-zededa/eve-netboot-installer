import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { api, type SettingsInfo } from "../admin";
import { Card, PageHeader } from "../components";
import { errorText, Fields, RollbackDialog, SaveStatus, useSaver, type Values } from "../forms";
import { SECTIONS, type SectionId } from "../sections";

export default function Settings({ section }: { section: SectionId }) {
  const def = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [error, setError] = useState("");
  const [changes, setChanges] = useState<Values>({});
  const load = () => api.settings().then(setInfo).catch((e) => setError(errorText(e)));
  const { state, save, reset } = useSaver(() => {
    setChanges({});
    load();
  });

  useEffect(() => {
    setChanges({});
    reset();
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  const set = (k: string, v: string) => {
    setChanges((c) => ({ ...c, [k]: v }));
    if (state.phase === "done" || state.phase === "error") reset();
  };
  const dirty = Object.keys(changes).length > 0;
  const fields = def.fields(info);

  return (
    <div className="page">
      <PageHeader title={def.title} subtitle={def.text} />
      {error && <div className="alert err">{error}</div>}
      <Card>
        {def.warning && (
          <div className="alert warn"><TriangleAlert size={16} /> {def.warning}</div>
        )}
        <Fields fields={fields} v={changes} info={info} set={set} />
        <div className="form-actions">
          <button className="btn primary" disabled={!dirty || state.phase === "saving"} onClick={() => save(changes)}>
            Save and apply
          </button>
          <button className="btn" disabled={!dirty || state.phase === "saving"} onClick={() => { setChanges({}); reset(); }}>
            Discard changes
          </button>
          <SaveStatus state={state} />
        </div>
      </Card>
      {state.phase === "rollback" && (
        <RollbackDialog result={state.result} onClose={() => { reset(); setChanges({}); load(); }} />
      )}
    </div>
  );
}
