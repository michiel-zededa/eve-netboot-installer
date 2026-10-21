import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { api } from "../admin";
import { Card, PageHeader } from "../components";
import { errorText, Fields, RollbackDialog, SaveStatus, useSaver } from "../forms";
import { useT } from "../i18n";
import { SECTIONS } from "../sections";
import ZededaSession from "./ZededaSession";
export default function Settings({ section, onSaved }) {
    const t = useT();
    const def = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
    const [info, setInfo] = useState(null);
    const [error, setError] = useState("");
    const [changes, setChanges] = useState({});
    const load = () => api.settings().then(setInfo).catch((e) => setError(errorText(e)));
    const { state, save, reset } = useSaver(() => {
        setChanges({});
        load();
        onSaved?.();
    });
    useEffect(() => {
        setChanges({});
        reset();
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [section]);
    const set = (k, v) => {
        setChanges((c) => ({ ...c, [k]: v }));
        if (state.phase === "done" || state.phase === "error")
            reset();
    };
    const dirty = Object.keys(changes).length > 0;
    const fields = def.fields(info, t);
    const text = t(`adm_sec_${def.id}_text`) + (def.note ? ` ${t(def.note)}` : "");
    return (_jsxs("div", { className: "page", children: [_jsx(PageHeader, { title: t(`adm_sec_${def.id}`), subtitle: text }), error && _jsx("div", { className: "alert err", children: error }), def.id === "zededa" && _jsx(ZededaSession, {}, state.phase), _jsxs(Card, { children: [def.warning && (_jsxs("div", { className: "alert warn", children: [_jsx(TriangleAlert, { size: 16 }), " ", t(def.warning)] })), _jsx(Fields, { fields: fields, v: changes, info: info, set: set }), _jsxs("div", { className: "form-actions", children: [_jsx("button", { className: "btn primary", disabled: !dirty || state.phase === "saving", onClick: () => save(changes), children: t("adm_save_apply") }), _jsx("button", { className: "btn", disabled: !dirty || state.phase === "saving", onClick: () => { setChanges({}); reset(); }, children: t("adm_discard") }), _jsx(SaveStatus, { state: state })] })] }), state.phase === "rollback" && (_jsx(RollbackDialog, { result: state.result, onClose: () => { reset(); setChanges({}); load(); } }))] }));
}
