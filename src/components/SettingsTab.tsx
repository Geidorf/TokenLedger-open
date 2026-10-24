import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  CircleGauge,
  Cloud,
  Database,
  DollarSign,
  Image as ImageIcon,
  Route,
  Search,
  Sliders,
  Wallet,
  X,
} from "lucide-react";
import {
  showsMacDynamicBackgroundControls,
  showsWindowsLockscreenControls,
} from "../utils/frontendContracts";
import {
  findSettingsDestinations,
  settingsNavigationStatus,
  SETTINGS_DESTINATIONS,
} from "../utils/settingsNavigation";
import { useSegmentedIndicator } from "../hooks/useSegmentedIndicator";
import "../styles/settings-navigation.css";
import { CloudAccountSection } from "./settings/CloudAccountSection";
import type { CloudAccountSectionProps } from "./settings/CloudAccountSection";
import { BudgetSection } from "./settings/BudgetSection";
import { QuotaSection } from "./settings/QuotaSection";
import type { QuotaSectionProps } from "./settings/QuotaSection";
import { WallpaperSection } from "./settings/WallpaperSection";
import type { WallpaperSectionProps } from "./settings/WallpaperSection";
import { ScanStartupSection } from "./settings/ScanStartupSection";
import type { ScanStartupSectionProps } from "./settings/ScanStartupSection";
import { WidgetSection } from "./settings/WidgetSection";
import type { WidgetSectionProps } from "./settings/WidgetSection";
import { PricingSection } from "./settings/PricingSection";
import type { PricingSectionProps } from "./settings/PricingSection";
import { PriceMigrationNoticeOpenContext } from "./settings/PriceMigrationNotice";
import { DataHelpSection } from "./settings/DataHelpSection";
import type { DataHelpSectionProps } from "./settings/DataHelpSection";
import { SettingsSection } from "./settings/SettingsPrimitives";
import { ModelAccessCard } from "../features/gateway/ModelAccessCard";
import type { ModelAccessCardProps } from "../features/gateway/ModelAccessCard";
import { LegacyRestoreCard } from "../features/gateway/LegacyRestoreCard";

type WallpaperInput = Omit<
  WallpaperSectionProps,
  "showDynamicBackgroundControls" | "showLockscreenControls"
>;
interface SettingsTabProps {
  cloud: CloudAccountSectionProps;
  quota: QuotaSectionProps;
  wallpaper: WallpaperInput;
  scanStartup: ScanStartupSectionProps;
  widget: WidgetSectionProps;
  pricing: PricingSectionProps;
  dataHelp: Omit<DataHelpSectionProps, "onOpenCloudSection">;
  modelAccess?: ModelAccessCardProps;
  settingsAnchor?: string | null;
  onSettingsAnchorHandled?: () => void;
}
const ICONS = { Cloud, CircleGauge, Sliders, ImageIcon, DollarSign, Database, AppWindow, Route, Wallet };
const DEFAULT_SECTION = "settings-scan";

function hashSection(): string {
  const value = window.location.hash.slice(1);
  return SETTINGS_DESTINATIONS.some((destination) => destination.id === value)
    ? value
    : DEFAULT_SECTION;
}

export function SettingsTab(props: SettingsTabProps) {
  const [activeSection, setActiveSection] = useState(() =>
    typeof window === "undefined" ? DEFAULT_SECTION : hashSection(),
  );
  const [query, setQuery] = useState("");
  // The price section's cleanup notice reports whether it is showing, for the
  // 「已整理」 badge on 「模型价格」 (T10.202).
  const [priceMigrationNoticeOpen, setPriceMigrationNoticeOpen] = useState(false);
  const [navigationRequest, setNavigationRequest] = useState(0);
  const focusSectionAfterNavigation = useRef(false);
  const pendingExternalAnchor = useRef<string | null>(null);
  const onSettingsAnchorHandledRef = useRef(props.onSettingsAnchorHandled);
  const directoryIndicatorRef = useSegmentedIndicator<HTMLElement>();
  const showDynamicBackgroundControls = showsMacDynamicBackgroundControls();
  const showLockscreenControls = showsWindowsLockscreenControls();
  const navigationState = {
    cloud: props.cloud.setup,
    quotaSyncStatus: props.quota.quotaSyncStatus,
    quotaProviders: props.quota.quotaProviders,
    appSettings: props.scanStartup.appSettings,
    pricing: {
      error: props.pricing.pricesError || props.pricing.pricesLoadError,
      dirty: props.pricing.pricesDirty,
      migrationNoticeOpen: priceMigrationNoticeOpen,
    },
    dbInfo: props.dataHelp.dbInfo,
    dbInfoError: props.dataHelp.dbInfoError,
  };
  const destinations = useMemo(() => findSettingsDestinations(query), [query]);
  const flushSettingChange = props.scanStartup.onFlushSettingChange;
  useEffect(() => {
    onSettingsAnchorHandledRef.current = props.onSettingsAnchorHandled;
  }, [props.onSettingsAnchorHandled]);
  useEffect(() => () => flushSettingChange(), [flushSettingChange]);
  useEffect(() => {
    const syncFromLocation = () => {
      focusSectionAfterNavigation.current = true;
      setActiveSection(hashSection());
      setNavigationRequest((value) => value + 1);
    };
    window.addEventListener("hashchange", syncFromLocation);
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncFromLocation);
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, []);
  useEffect(() => {
    if (
      !props.settingsAnchor ||
      !SETTINGS_DESTINATIONS.some((item) => item.id === props.settingsAnchor)
    )
      return;
    window.history.replaceState(null, "", `#${props.settingsAnchor}`);
    focusSectionAfterNavigation.current = true;
    pendingExternalAnchor.current = props.settingsAnchor;
    setActiveSection(props.settingsAnchor);
    setNavigationRequest((value) => value + 1);
  }, [props.settingsAnchor]);
  useEffect(() => {
    const content = document.querySelector<HTMLElement>(".app-content");
    if (content) content.scrollTop = 0;
    if (
      pendingExternalAnchor.current &&
      pendingExternalAnchor.current !== activeSection
    )
      return;
    if (!focusSectionAfterNavigation.current) return;
    focusSectionAfterNavigation.current = false;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(activeSection);
      target?.focus({ preventScroll: true });
      if (pendingExternalAnchor.current === activeSection && target) {
        pendingExternalAnchor.current = null;
        onSettingsAnchorHandledRef.current?.();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, navigationRequest]);
  const selectSection = (id: string) => {
    if (window.location.hash !== `#${id}`)
      window.history.pushState(null, "", `#${id}`);
    focusSectionAfterNavigation.current = false;
    pendingExternalAnchor.current = null;
    setActiveSection(id);
    setNavigationRequest((value) => value + 1);
  };
  const openCloud = () => selectSection("settings-cloud");

  return (
    <div className="settings-page settings-navigation-page">
      <h1 className="sr-only">设置</h1>
      <div className="settings-directory">
        <div className="settings-directory-search">
          <Search className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">搜索设置</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索设置"
            placeholder="搜索设置"
            type="search"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清除设置搜索"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <nav className="settings-directory-list tl-seg" aria-label="设置分区" ref={directoryIndicatorRef}>
          {destinations.map((destination) => {
            const Icon = ICONS[destination.icon];
            const status = settingsNavigationStatus(
              destination.id,
              navigationState,
            );
            return (
              <button
                key={destination.id}
                type="button"
                className={activeSection === destination.id ? "is-active" : ""}
                aria-current={
                  activeSection === destination.id ? "page" : undefined
                }
                onClick={() => selectSection(destination.id)}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>
                  <strong>{destination.label}</strong>
                  <small>{destination.description}</small>
                </span>
                {status && (
                  <em
                    className={`settings-nav-status settings-nav-status-${status.tone}`}
                  >
                    {status.label}
                  </em>
                )}
              </button>
            );
          })}
          {destinations.length === 0 && (
            /* 搜索只筛这份目录，右侧照旧渲染全部分区；文案要说清这一点，
               否则「没有匹配的设置」会和右边满屏的设置直接打架（T10.128 P1）。 */
            <p className="settings-directory-empty">
              目录里没有匹配项，右侧仍是全部设置。
              <button type="button" onClick={() => setQuery("")}>
                清除搜索
              </button>
            </p>
          )}
        </nav>
        <p className="settings-save-note">
          开关与间隔自动保存；账户、接口、价格用各自的保存按钮。
        </p>
      </div>
      <div className="settings-main settings-navigation-main">
        <section
          hidden={activeSection !== "settings-scan"}
          aria-hidden={activeSection !== "settings-scan"}
        >
          <ScanStartupSection {...props.scanStartup} />
        </section>
        <section
          hidden={activeSection !== "settings-widget"}
          aria-hidden={activeSection !== "settings-widget"}
        >
          <WidgetSection {...props.widget} />
        </section>
        <section
          hidden={activeSection !== "settings-wallpaper"}
          aria-hidden={activeSection !== "settings-wallpaper"}
        >
          <WallpaperSection
            {...props.wallpaper}
            showDynamicBackgroundControls={showDynamicBackgroundControls}
            showLockscreenControls={showLockscreenControls}
          />
        </section>
        {activeSection === "settings-cloud" && (
          <section>
            <CloudAccountSection {...props.cloud} />
          </section>
        )}
        <section
          hidden={activeSection !== "settings-quota"}
          aria-hidden={activeSection !== "settings-quota"}
        >
          <QuotaSection {...props.quota} />
        </section>
        {activeSection === "settings-budget" && (
          <section>
            <BudgetSection />
          </section>
        )}
        {props.modelAccess && (
          <section
            hidden={activeSection !== "settings-model-access"}
            aria-hidden={activeSection !== "settings-model-access"}
          >
            <SettingsSection id="model-access" title="模型接入">
              <ModelAccessCard {...props.modelAccess} />
              {activeSection === "settings-model-access" && <LegacyRestoreCard
                onConfirm={props.quota.onConfirm}
                onResolved={() => {}}
                allowGatewayChoice={false}
              />}
            </SettingsSection>
          </section>
        )}
        <section
          hidden={activeSection !== "settings-pricing"}
          aria-hidden={activeSection !== "settings-pricing"}
        >
          <PriceMigrationNoticeOpenContext.Provider value={setPriceMigrationNoticeOpen}>
            <PricingSection {...props.pricing} />
          </PriceMigrationNoticeOpenContext.Provider>
        </section>
        <section
          hidden={activeSection !== "settings-data"}
          aria-hidden={activeSection !== "settings-data"}
        >
          <DataHelpSection {...props.dataHelp} onOpenCloudSection={openCloud} />
        </section>
      </div>
    </div>
  );
}

export default SettingsTab;
