import { useCallback, useEffect, useState } from "react";
import { getSession, type Session, type SettingsInfo, api } from "./admin";
import { loadActivity, loadStatus, loadTexts, type Activity, type Status } from "./api";
import { ToastHost } from "./forms";
import { fallback, TextsContext, type Texts } from "./i18n";
import Layout from "./Layout";
import Boot from "./pages/Boot";
import Home from "./pages/Home";
import Images, { type ImageTab } from "./pages/Images";
import { ConfirmNetwork, Login } from "./pages/Login";
import { Backup, Logs, System, Updates } from "./pages/Maintenance";
import Settings from "./pages/Settings";
import Setup from "./pages/Setup";
import { SECTIONS, type SectionId } from "./sections";

const POLL_MS = 10_000;

export type Route =
  | { page: "home" }
  | { page: "images"; tab: ImageTab }
  | { page: "boot" }
  | { page: "settings"; section: SectionId }
  | { page: "logs" | "updates" | "backup" | "system" }
  | { page: "confirm"; token: string };

function parseHash(): Route {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  switch (parts[0]) {
    case "images":
      return { page: "images", tab: parts[1] === "github" || parts[1] === "local" ? parts[1] : "all" };
    case "boot":
      return { page: "boot" };
    case "settings": {
      const section = SECTIONS.find((s) => s.id === parts[1])?.id ?? "network";
      return { page: "settings", section };
    }
    case "logs":
    case "updates":
    case "backup":
    case "system":
      return { page: parts[0] };
    case "confirm":
      return { page: "confirm", token: parts[1] ?? "" };
    default:
      return { page: "home" };
  }
}

export function href(route: Route): string {
  switch (route.page) {
    case "images":
      return route.tab === "all" ? "#/images" : `#/images/${route.tab}`;
    case "settings":
      return `#/settings/${route.section}`;
    case "confirm":
      return `#/confirm/${route.token}`;
    case "home":
      return "#/";
    default:
      return `#/${route.page}`;
  }
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [status, setStatus] = useState<Status | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [texts, setTexts] = useState<Texts>(fallback);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  // undefined = still checking; null = plain PXE server (read-only)
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [info, setInfo] = useState<SettingsInfo | null>(null);

  const refresh = useCallback(async () => {
    const [s, a] = await Promise.all([loadStatus(), loadActivity()]);
    if (s) setStatus(s);
    setActivity(a);
    setLoaded(true);
  }, []);

  const refreshSession = useCallback(async () => {
    const s = await getSession();
    setSession(s);
    if (s?.authenticated) api.settings().then(setInfo).catch(() => {});
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    loadTexts().then((t) => {
      if (t) {
        setTexts({ ...fallback, ...t.texts });
        document.documentElement.lang = t.language;
      }
    });
    refreshSession();
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, refreshSession]);

  const onSearch = (q: string) => {
    setSearch(q);
    if (q && route.page !== "images") location.hash = href({ page: "images", tab: "all" });
  };

  let content;
  if (session === undefined) {
    content = null;
  } else if (route.page === "confirm") {
    content = <ConfirmNetwork token={route.token} />;
  } else if (session && !session.configured) {
    content = <Setup onDone={() => { location.hash = "#/"; refreshSession(); refresh(); }} />;
  } else if (session && !session.authenticated) {
    content = <Login hostname={session.hostname} onLogin={refreshSession} />;
  } else {
    const admin = !!session?.authenticated;
    content = (
      <Layout route={route} status={status} search={search} onSearch={onSearch} onRefresh={refresh}
        session={session} onLogout={() => api.logout().finally(refreshSession)}>
        {!loaded ? null : route.page === "images" ? (
          <Images status={status} activity={activity} tab={route.tab} search={search} onSearch={setSearch}
            admin={admin} onChanged={refresh} />
        ) : route.page === "boot" ? (
          <Boot status={status} />
        ) : admin && route.page === "settings" ? (
          <Settings section={route.section} />
        ) : admin && route.page === "logs" ? (
          <Logs />
        ) : admin && route.page === "updates" ? (
          <Updates info={info} />
        ) : admin && route.page === "backup" ? (
          <Backup />
        ) : admin && route.page === "system" ? (
          <System />
        ) : (
          <Home status={status} activity={activity} />
        )}
      </Layout>
    );
  }

  return (
    <TextsContext.Provider value={texts}>
      <ToastHost>{content}</ToastHost>
    </TextsContext.Provider>
  );
}
