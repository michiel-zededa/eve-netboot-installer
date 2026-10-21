import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { CircleCheck, Loader, LogIn } from "lucide-react";
import { api } from "../admin";
import { errorText } from "../forms";
import { PRODUCT, useT } from "../i18n";
export function Login({ hostname, onLogin }) {
    const t = useT();
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api.login(password);
            onLogin();
        }
        catch (err) {
            setError(errorText(err));
            setPassword("");
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx("div", { className: "center-page", children: _jsxs("form", { className: "card login", onSubmit: submit, children: [_jsx("span", { className: "logo big" }), _jsx("h1", { children: PRODUCT }), _jsx("p", { className: "muted", children: t("adm_login_web", { host: hostname }) }), error && _jsx("div", { className: "alert err", children: error }), _jsx("label", { className: "field-label", htmlFor: "pw", children: t("adm_admin_password") }), _jsx("input", { id: "pw", type: "password", autoComplete: "current-password", autoFocus: true, value: password, onChange: (e) => setPassword(e.target.value) }), _jsxs("button", { className: "btn primary block", disabled: !password || busy, children: [busy ? _jsx(Loader, { size: 16, className: "spin" }) : _jsx(LogIn, { size: 16 }), " ", t("adm_login")] })] }) }));
}
/** #/confirm/<token>: opened at the new address after a network change. */
export function ConfirmNetwork({ token }) {
    const t = useT();
    const [state, setState] = useState("busy");
    const [message, setMessage] = useState("");
    useEffect(() => {
        api.confirmNetwork(token)
            .then(() => setState("ok"))
            .catch((e) => { setState("err"); setMessage(errorText(e)); });
    }, [token]);
    return (_jsx("div", { className: "center-page", children: _jsxs("div", { className: "card login", children: [_jsx("span", { className: "logo big" }), state === "busy" && _jsxs("p", { children: [_jsx(Loader, { size: 18, className: "spin" }), " ", t("adm_rb_confirming")] }), state === "ok" && (_jsxs(_Fragment, { children: [_jsxs("h1", { children: [_jsx(CircleCheck, { size: 22, className: "ok-text" }), " ", t("adm_rb_confirmed")] }), _jsx("p", { className: "muted", children: t("adm_rb_confirmed_text") }), _jsx("a", { className: "btn primary block", href: "#/", children: t("adm_btn_continue") })] })), state === "err" && (_jsxs(_Fragment, { children: [_jsx("h1", { children: t("adm_rb_not_confirmed") }), _jsx("div", { className: "alert err", children: message }), _jsx("p", { className: "muted", children: t("adm_rb_ran_out") })] }))] }) }));
}
