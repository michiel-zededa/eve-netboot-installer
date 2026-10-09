import { CircleAlert, CircleCheck, CloudDownload, FolderInput, HardDrive, Loader, Moon } from "lucide-react";
import { imageState, serverHost, type Activity, type Status } from "../api";
import { Card, CopyField, Donut, PageHeader, StatCard } from "../components";
import { useT } from "../i18n";

export default function Home({ status, activity }: { status: Status | null; activity: Activity | null }) {
  const t = useT();
  const entries = status?.entries ?? [];
  const n = { ready: 0, not_netboot: 0, error: 0, github: 0, local: 0 };
  for (const e of entries) {
    n[imageState(e)]++;
    n[e.source]++;
  }
  const problems = n.not_netboot + n.error;
  const disk = activity?.disk;
  const host = serverHost(status?.config);

  return (
    <div className="page">
      <PageHeader title={t("ui_home_title")} subtitle={t("ui_home_text")} />

      <div className="stat-grid">
        <StatCard value={n.ready} label={t("ui_card_ready")} icon={<CircleCheck size={20} />} tone="ok"
          badge={entries.length ? `${Math.round((n.ready / entries.length) * 100)}%` : undefined} href="#/images" />
        <StatCard value={n.github} label={t("ui_card_github")} icon={<CloudDownload size={20} />} href="#/images/github" />
        <StatCard value={n.local} label={t("ui_card_local")} icon={<FolderInput size={20} />} href="#/images/local" />
        <StatCard value={problems} label={t("ui_card_problems")} icon={<CircleAlert size={20} />}
          tone={problems ? "err" : undefined} href="#/images" />
        <StatCard value={disk ? `${disk.free_gb.toFixed(0)}` : "-"} label={t("ui_card_disk")}
          icon={<HardDrive size={20} />} badge={disk ? "GB" : undefined} />
      </div>

      <div className="grid-3">
        <Card title={t("ui_image_health")}>
          <Donut
            parts={[
              { value: n.ready, tone: "ok" },
              { value: n.not_netboot, tone: "warn" },
              { value: n.error, tone: "err" },
            ]}
            center={`${n.ready}/${entries.length}`}
            sub={t("ui_card_ready")}
          />
          <ul className="legend">
            <li><i className="dot ok" />{t("ui_pill_ready")} <b>{n.ready}</b></li>
            <li><i className="dot warn" />{t("ui_pill_not_netboot")} <b>{n.not_netboot}</b></li>
            <li><i className="dot err" />{t("ui_pill_error")} <b>{n.error}</b></li>
          </ul>
        </Card>

        <Card title={t("ui_activity")}>
          <ActivityView activity={activity} status={status} />
        </Card>

        <Card title={t("ui_dhcp_title")}>
          <p className="muted small">{t("ui_dhcp_text")}</p>
          <CopyField label={t("ui_next_server")} value={host} />
          <CopyField label={t("ui_boot_file")} value="eve-x86_64.efi" hint={t("ui_boot_file_x86")} />
          <CopyField label={t("ui_boot_file")} value="eve-arm64.efi" hint={t("ui_boot_file_arm")} />
          <a className="link small" href="#/boot">{t("ui_more_boot")}</a>
        </Card>
      </div>
    </div>
  );
}

function ActivityView({ activity, status }: { activity: Activity | null; status: Status | null }) {
  const t = useT();
  const busy = activity && activity.state !== "idle";
  const cfg = status?.config;
  return (
    <div className="activity">
      {busy ? (
        <>
          <div className="activity-state">
            <Loader size={20} className="spin" />
            <strong>
              {activity!.state === "downloading"
                ? t("ui_downloading", { item: activity!.item ?? "" })
                : t("ui_importing", { item: activity!.item ?? "" })}
            </strong>
          </div>
          {activity!.percent !== undefined && (
            <>
              <div className="progress" role="progressbar" aria-valuenow={activity!.percent} aria-valuemin={0}
                aria-valuemax={100}>
                <span style={{ width: `${activity!.percent}%` }} />
              </div>
              <div className="muted small">
                {activity!.done_mb} / {activity!.total_mb} MB ({activity!.percent}%)
              </div>
            </>
          )}
        </>
      ) : (
        <div className="activity-state">
          <Moon size={20} />
          <strong>{t("ui_idle")}</strong>
        </div>
      )}
      <ul className="facts">
        <li>{t("ui_last_check", { date: status?.github_checked ?? t("ui_never") })}</li>
        {activity?.next_github_check && <li>{t("ui_next_check", { date: activity.next_github_check })}</li>}
        {cfg && (
          <li>
            {t("ui_mirror_text", { lines: cfg.lts_lines })}: {cfg.arches.join(", ")} · {cfg.flavours.join(", ")}
          </li>
        )}
      </ul>
    </div>
  );
}
