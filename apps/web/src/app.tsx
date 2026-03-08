import { Routes, Route, Outlet, useLocation, Navigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PackageList } from "./pages/package-list";
import { UnifiedPackageDetailPage } from "./pages/unified-package-detail";
import { PackageEditorPage } from "./pages/package-editor";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ShareableRunPage } from "./pages/shareable-run";
import { PublicShareRunPage } from "./pages/public-share-run";
import { SchedulesListPage } from "./pages/schedules-list";
import { ExecutionsPage } from "./pages/executions-page";
import { MarketplacePage } from "./pages/marketplace";
import { MarketplaceDetailPage } from "./pages/marketplace-detail";
import { MarketplaceUpdatesPage } from "./pages/marketplace-updates";
import { MarketplacePublishPage } from "./pages/marketplace-publish";
import { MarketplaceConnectionPage } from "./pages/marketplace-connection";
import { CreateOrgPage } from "./pages/create-org";
import { InviteAcceptPage } from "./pages/invite-accept";
import { WelcomePage } from "./pages/welcome";
import { OrgSettingsPage } from "./pages/org-settings";
import { SkillsPage } from "./pages/skills-page";
import { ExtensionsPage } from "./pages/extensions-page";
import { ProvidersPage } from "./pages/providers-page";
import { PreferencesPage } from "./pages/preferences";
import { LoginPage } from "./pages/login";
import { ErrorBoundary } from "./components/error-boundary";
import { OrgSwitcher } from "./components/org-switcher";
import { NotificationBell } from "./components/notification-bell";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "./hooks/use-theme";
import { useAuth } from "./hooks/use-auth";
import { useOrg } from "./hooks/use-org";
import { useGlobalExecutionSync } from "./hooks/use-global-execution-sync";
import { useProfileAutoSelect } from "./hooks/use-current-profile";
import { Spinner } from "./components/spinner";
import {
  User,
  Settings,
  Download,
  FileText,
  LogOut,
  ShoppingBag,
  Sun,
  Moon,
  Monitor,
  Palette,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";

function UserMenu({
  displayName,
  isAdmin,
  onLogout,
}: {
  displayName: string;
  isAdmin?: boolean;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  const themeOptions = [
    { value: "light" as const, label: t("userMenu.themeLight"), icon: Sun },
    { value: "dark" as const, label: t("userMenu.themeDark"), icon: Moon },
    { value: "system" as const, label: t("userMenu.themeSystem"), icon: Monitor },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label={t("userMenu.ariaLabel")}
        >
          <User size={18} className="shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <span>{displayName}</span>
          {isAdmin && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium uppercase">
              {t("admin")}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/preferences" className="flex items-center gap-2">
            <Settings size={14} />
            {t("userMenu.preferences")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette size={14} />
            {t("userMenu.theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {themeOptions.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onSelect={() => setTheme(opt.value)}
                className="flex items-center gap-2"
              >
                <opt.icon size={14} />
                {opt.label}
                {theme === opt.value && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem asChild>
          <a
            href="/api/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <FileText size={14} />
            {t("userMenu.apiDocs")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href="/assets/appstrate-api-guide.zip"
            download="appstrate-api-guide.zip"
            className="flex items-center gap-2"
          >
            <Download size={14} />
            {t("nav.downloadSkill")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} className="flex items-center gap-2">
          <LogOut size={14} />
          {t("userMenu.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MainLayout() {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const { user, profile, logout } = useAuth();
  const { isOrgAdmin } = useOrg();

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="flex items-center gap-2 mb-8 pb-4 border-b border-border">
        <Link to="/" className="flex items-center shrink-0 mr-auto">
          <img
            src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
            alt="Appstrate"
            className="h-[34px] w-auto"
          />
        </Link>
        <OrgSwitcher />
        <Link
          to="/marketplace"
          className="inline-flex items-center justify-center size-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Marketplace"
        >
          <ShoppingBag size={18} />
        </Link>
        <NotificationBell />
        <div className="mx-2 h-5 w-px bg-border" />
        <UserMenu
          displayName={profile?.displayName || user!.email || ""}
          isAdmin={isOrgAdmin}
          onLogout={() => void handleLogout()}
        />
      </header>
      <Outlet />
    </div>
  );
}

function GlobalRealtimeSync({ children }: { children: React.ReactNode }) {
  useGlobalExecutionSync();
  useProfileAutoSelect();
  return <>{children}</>;
}

function OrgGate({ children }: { children: React.ReactNode }) {
  const { currentOrg, orgs, loading } = useOrg();
  const location = useLocation();

  // Allow create-org and welcome routes through without org context
  if (location.pathname === "/create-org" || location.pathname === "/welcome") {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Spinner />
        </div>
      </div>
    );
  }

  // No orgs at all — redirect to create
  if (orgs.length === 0) {
    return <Navigate to="/create-org" replace />;
  }

  // Orgs exist but none selected yet (auto-select happening)
  if (!currentOrg) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Spinner />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Public share routes — no authentication required
  if (location.pathname.startsWith("/share/")) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/share/:token" element={<PublicShareRunPage />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  // Public invitation routes — no authentication required
  if (location.pathname.startsWith("/invite/")) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/invite/:token" element={<InviteAcceptPage />} />
        </Routes>
      </ErrorBoundary>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Spinner />
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <ErrorBoundary>
      <Toaster />
      <OrgGate>
        <GlobalRealtimeSync>
          <Routes>
            <Route path="/create-org" element={<CreateOrgPage />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/flows/:scope/:name/run" element={<ShareableRunPage />} />
            <Route element={<MainLayout />}>
              <Route path="/" element={<PackageList />} />
              <Route path="/flows/new" element={<PackageEditorPage type="flow" />} />
              <Route path="/flows/:scope/:name/edit" element={<PackageEditorPage type="flow" />} />
              <Route
                path="/flows/:scope/:name"
                element={<UnifiedPackageDetailPage type="flow" />}
              />
              <Route
                path="/flows/:scope/:name/:version"
                element={<UnifiedPackageDetailPage type="flow" />}
              />
              <Route
                path="/flows/:scope/:name/executions/:execId"
                element={<ExecutionDetailPage />}
              />
              <Route path="/executions" element={<ExecutionsPage />} />
              <Route path="/schedules" element={<SchedulesListPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/extensions" element={<ExtensionsPage />} />
              <Route path="/providers" element={<ProvidersPage />} />
              <Route path="/skills/new" element={<PackageEditorPage type="skill" />} />
              <Route
                path="/skills/:scope/:name/edit"
                element={<PackageEditorPage type="skill" />}
              />
              <Route
                path="/skills/:scope/:name"
                element={<UnifiedPackageDetailPage type="skill" />}
              />
              <Route
                path="/skills/:scope/:name/:version"
                element={<UnifiedPackageDetailPage type="skill" />}
              />
              <Route path="/extensions/new" element={<PackageEditorPage type="extension" />} />
              <Route
                path="/extensions/:scope/:name/edit"
                element={<PackageEditorPage type="extension" />}
              />
              <Route
                path="/extensions/:scope/:name"
                element={<UnifiedPackageDetailPage type="extension" />}
              />
              <Route
                path="/extensions/:scope/:name/:version"
                element={<UnifiedPackageDetailPage type="extension" />}
              />
              <Route path="/providers/new" element={<PackageEditorPage type="provider" />} />
              <Route
                path="/providers/:scope/:name/edit"
                element={<PackageEditorPage type="provider" />}
              />
              <Route
                path="/providers/:scope/:name"
                element={<UnifiedPackageDetailPage type="provider" />}
              />
              <Route
                path="/providers/:scope/:name/:version"
                element={<UnifiedPackageDetailPage type="provider" />}
              />
              <Route path="/library" element={<Navigate to="/skills" replace />} />
              <Route path="/marketplace" element={<MarketplacePage />} />
              <Route path="/marketplace/updates" element={<MarketplaceUpdatesPage />} />
              <Route path="/marketplace/publish" element={<MarketplacePublishPage />} />
              <Route path="/marketplace/connection" element={<MarketplaceConnectionPage />} />
              <Route path="/marketplace/:scope/:name" element={<MarketplaceDetailPage />} />
              <Route path="/preferences" element={<PreferencesPage />} />
              <Route path="/connectors" element={<Navigate to="/providers" replace />} />
              <Route path="/org-settings" element={<OrgSettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </GlobalRealtimeSync>
      </OrgGate>
    </ErrorBoundary>
  );
}
