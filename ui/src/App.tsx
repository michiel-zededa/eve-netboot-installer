import { useCallback, useEffect, useState } from "react";
import { loadActivity, loadStatus, loadTexts, type Activity, type Status } from "./api";
import { fallback, TextsContext, type Texts } from "./i18n";
import Layout from "./Layout";
import Home from "./pages/Home";
import Images, { type ImageTab } from "./pages/Images";
import Boot from "./pages/Boot";

const POLL_MS = 10_000;

export type Route =
  | { page: "home" }
  | { page: "images"; tab: ImageTab }
  | { page: "boot" };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("images")) {
    const tab = h.split("/")[1];
    return { page: "images", tab: tab === "github" || tab === "local" ? tab : "all" };
  }
  if (h === "boot") return { page: "boot" };
  return { page: "home" };
}

export function href(route: Route): string {
  if (route.page === "images") return route.tab === "all" ? "#/images" : `#/images/${route.tab}`;
  return route.page === "home" ? "#/" : `#/${route.page}`;
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [status, setStatus] = useState<Status | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [texts, setTexts] = useState<Texts>(fallback);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    const [s, a] = await Promise.all([loadStatus(), loadActivity()]);
    if (s) setStatus(s);
    setActivity(a);
    setLoaded(true);
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
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const onSearch = (q: string) => {
    setSearch(q);
    if (q && route.page !== "images") location.hash = href({ page: "images", tab: "all" });
  };

  return (
    <TextsContext.Provider value={texts}>
      <Layout route={route} status={status} search={search} onSearch={onSearch} onRefresh={refresh}>
        {!loaded ? null : route.page === "images" ? (
          <Images status={status} activity={activity} tab={route.tab} search={search} onSearch={setSearch} />
        ) : route.page === "boot" ? (
          <Boot status={status} />
        ) : (
          <Home status={status} activity={activity} />
        )}
      </Layout>
    </TextsContext.Provider>
  );
}
