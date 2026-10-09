import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CloudDownload, ExternalLink, FolderInput, Layers, Search, Trash2, Upload, X } from "lucide-react";
import { ApiError, api, uploadIso } from "../admin";
import { Confirm, errorText, useToast } from "../forms";
import {
  formatSize, imageDate, imageName, imageState, type Activity, type Entry, type Status,
} from "../api";
import { href } from "../App";
import { Drawer, Empty, KeyValues, PageHeader, Pill, StatePill } from "../components";
import { useT } from "../i18n";

export type ImageTab = "all" | "github" | "local";
type SortKey = "name" | "source" | "status" | "arch" | "variant" | "size" | "date";

interface Props {
  status: Status | null;
  activity: Activity | null;
  tab: ImageTab;
  search: string;
  onSearch: (q: string) => void;
  admin?: boolean;
  onChanged?: () => void;
}

const STATE_ORDER = { error: 0, not_netboot: 1, ready: 2 };

export default function Images({ status, activity, tab, search, onSearch, admin, onChanged }: Props) {
  const t = useT();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [overwrite, setOverwrite] = useState<File | null>(null);

  const doUpload = async (file: File, replace = false) => {
    setUpload({ name: file.name, pct: 0 });
    try {
      await uploadIso(file, replace, (pct) => setUpload({ name: file.name, pct }));
      toast(`${file.name} uploaded; it appears in the list within a minute.`);
      onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setOverwrite(file);
      else toast(errorText(e), "err");
    } finally {
      setUpload(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const [arch, setArch] = useState("");
  const [variant, setVariant] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "date", desc: true });
  const [selected, setSelected] = useState<string | null>(null);

  const entries = status?.entries ?? [];
  const arches = [...new Set(entries.map((e) => e.arch).filter(Boolean))] as string[];
  const variants = [...new Set(entries.map((e) => e.variant).filter(Boolean))] as string[];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = entries.filter((e) =>
      (tab === "all" || e.source === tab) &&
      (!arch || e.arch === arch) &&
      (!variant || e.variant === variant) &&
      (!q || [imageName(e), e.arch, e.variant, e.source, e.error].join(" ").toLowerCase().includes(q)));
    const val = (e: Entry): string | number => {
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
  const title = tab === "github" ? t("ui_nav_github") : tab === "local" ? t("ui_nav_local") : t("ui_nav_all");
  const folder = status?.config.import_label || t("import_folder");

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th aria-sort={sort.key === k ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button onClick={() => setSort({ key: k, desc: sort.key === k ? !sort.desc : false })}>
        {label}
        {sort.key === k ? (sort.desc ? <ArrowDown size={14} /> : <ArrowUp size={14} />) : <span className="sort-ph" />}
      </button>
    </th>
  );

  return (
    <div className="page">
      <PageHeader title={title} subtitle={t("ui_images_text")}>
        {admin && (
          <>
            <input ref={fileRef} type="file" accept=".iso" hidden
              onChange={(e) => e.target.files?.[0] && doUpload(e.target.files[0])} />
            <button className="btn primary slim" disabled={!!upload} onClick={() => fileRef.current?.click()}>
              <Upload size={16} /> Upload ISO
            </button>
          </>
        )}
      </PageHeader>
      {upload && (
        <div className="notice upload">
          <span>Uploading <b>{upload.name}</b> ({upload.pct}%)</span>
          <div className="progress"><span style={{ width: `${upload.pct}%` }} /></div>
        </div>
      )}
      {overwrite && (
        <Confirm title="File exists" text={<>{overwrite.name} is already in the import folder. Replace it?</>}
          confirm="Replace" onConfirm={() => doUpload(overwrite, true)} onClose={() => setOverwrite(null)} />
      )}

      <div className="tabs" role="tablist">
        {(["all", "github", "local"] as ImageTab[]).map((v) => (
          <a key={v} role="tab" aria-selected={tab === v} className={`tab${tab === v ? " active" : ""}`}
            href={href({ page: "images", tab: v })}>
            {v === "all" ? t("ui_nav_all") : v === "github" ? t("ui_nav_github") : t("ui_nav_local")}
          </a>
        ))}
      </div>

      {activity && activity.state !== "idle" && (
        <div className="notice">
          <Pill tone="info">{activity.percent !== undefined ? `${activity.percent}%` : "…"}</Pill>
          {activity.state === "downloading"
            ? t("ui_downloading", { item: activity.item ?? "" })
            : t("ui_importing", { item: activity.item ?? "" })}
        </div>
      )}

      <div className="toolbar">
        {search && (
          <button className="chip" onClick={() => onSearch("")}>
            <Search size={14} /> “{search}” <X size={14} />
          </button>
        )}
        <span className="muted">{rows.length === 1 ? t("ui_count_image") : t("ui_count_images", { n: rows.length })}</span>
        <div className="toolbar-right">
          <select value={arch} onChange={(e) => setArch(e.target.value)} aria-label={t("th_arch")}>
            <option value="">{t("ui_filter_all_arches")}</option>
            {arches.map((a) => <option key={a}>{a}</option>)}
          </select>
          <select value={variant} onChange={(e) => setVariant(e.target.value)} aria-label={t("th_variant")}>
            <option value="">{t("ui_filter_all_variants")}</option>
            {variants.map((v) => <option key={v}>{v}</option>)}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <Empty
            icon={tab === "local" ? <FolderInput size={32} /> : tab === "github" ? <CloudDownload size={32} /> : <Layers size={32} />}
            text={search || arch || variant ? t("ui_no_match")
              : tab === "local" ? t("ui_empty_local", { folder }) : t("ui_empty_github")}
          />
        </div>
      ) : (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <Th k="name" label={t("ui_col_name")} />
                <Th k="source" label={t("th_source")} />
                <Th k="status" label={t("th_status")} />
                <Th k="arch" label={t("th_arch")} />
                <Th k="variant" label={t("th_variant")} />
                <Th k="size" label={t("ui_col_size")} />
                <th>SHA256</th>
                <Th k="date" label={t("ui_col_date")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.path} onClick={() => setSelected(e.path)} tabIndex={0}
                  onKeyDown={(ev) => ev.key === "Enter" && setSelected(e.path)}>
                  <td>
                    <span className="name-cell">
                      <span className="row-icon">{e.source === "github" ? <CloudDownload size={16} /> : <FolderInput size={16} />}</span>
                      <span className="link">{imageName(e)}</span>
                    </span>
                  </td>
                  <td>{e.source === "github" ? "GitHub" : t("ui_src_local")}</td>
                  <td><StatePill state={imageState(e)} /></td>
                  <td>{e.arch ?? "—"}</td>
                  <td>{e.variant || "—"}</td>
                  <td className="num">{formatSize(e.iso_size) || "—"}</td>
                  <td>{e.error ? "—" : e.sha256_verified ? <Pill tone="ok">{t("sha_verified")}</Pill>
                    : e.sha256 ? <Pill tone="neutral">{t("sha_computed")}</Pill> : "—"}</td>
                  <td className="num">{imageDate(e) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {current && <ImageDetail entry={current} admin={admin} onClose={() => setSelected(null)}
        onDeleted={() => { setSelected(null); onChanged?.(); }} />}
    </div>
  );
}

function ImageDetail({ entry: e, admin, onClose, onDeleted }: {
  entry: Entry; admin?: boolean; onClose: () => void; onDeleted: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const remove = () => api.deleteImage(e.file ?? "")
    .then(() => { toast(`${e.file} deleted; it disappears from the menu within a minute.`); onDeleted(); })
    .catch((err) => toast(errorText(err), "err"));
  const yesNo = (v?: boolean | null) => (v === undefined || v === null ? "" : v ? t("ui_yes") : t("ui_no"));
  return (
    <Drawer title={<>{imageName(e)} <StatePill state={imageState(e)} /></>} onClose={onClose}>
      {e.error && <div className="alert err">{e.error}</div>}
      {!e.error && !e.netboot_ok && <div className="alert warn">{t("err_netboot_1")}</div>}
      <KeyValues rows={[
        [t("th_source"), e.source === "github" ? "GitHub" : t("ui_src_local")],
        [t("ui_detail_file"), e.source === "local" ? <code className="mono break">{e.file}</code> : null],
        [t("th_arch"), e.arch],
        [t("th_variant"), e.variant],
        [t("ui_col_size"), formatSize(e.iso_size)],
        [e.source === "github" ? t("ui_detail_published") : t("ui_detail_modified"), imageDate(e)],
        [t("ui_detail_prepared"), e.prepared?.replace("T", " ")],
        [t("ui_detail_ucode"), yesNo(e.ucode)],
        [t("ui_detail_config_img"), yesNo(e.config_img)],
        ["SHA256", e.sha256 ? (
          <span className="mono break">{e.sha256} <br />
            <span className="muted small">{e.sha256_verified ? t("ui_detail_sha_verified") : t("ui_detail_sha_computed")}</span>
          </span>) : null],
        [t("ui_detail_console"), e.console ? <code className="mono">{e.console}</code> : null],
        [t("ui_detail_kernel_args"), e.args ? <code className="mono break block">{e.args}</code> : null],
      ]} />
      <div className="form-actions">
        {!e.error && (
          <a className="btn" href={`eve/${e.path}/`} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> {t("ui_open_files")}
          </a>
        )}
        {admin && e.source === "local" && e.file && (
          <button className="btn danger" onClick={() => setAsk(true)}><Trash2 size={16} /> Delete from the import folder</button>
        )}
      </div>
      {ask && (
        <Confirm title="Delete ISO" danger confirm="Delete" onConfirm={remove} onClose={() => setAsk(false)}
          text={<>Delete <b>{e.file}</b> from the import folder? It is removed from the boot menu.</>} />
      )}
    </Drawer>
  );
}
