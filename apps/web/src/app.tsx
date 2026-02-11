import { Routes, Route, useLocation, Navigate, Link } from "react-router-dom";
import { FlowList } from "./pages/flow-list";
import { FlowDetailPage } from "./pages/flow-detail";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ServicesListPage } from "./pages/services-list";
import { SchedulesListPage } from "./pages/schedules-list";
import { ErrorBoundary } from "./components/error-boundary";
import { useWebSocketInit } from "./hooks/use-websocket";

export function App() {
  const location = useLocation();

  useWebSocketInit();

  const currentPath = location.pathname;

  return (
    <div className="container">
      <header>
        <h1>
          <Link to="/" className="logo-link">
            <span>App</span>strate
          </Link>
        </h1>
        <nav className="main-nav">
          <Link
            className={`nav-tab ${currentPath === "/" || currentPath.startsWith("/flows") ? "active" : ""}`}
            to="/"
          >
            Flows
          </Link>
          <Link
            className={`nav-tab ${currentPath === "/schedules" ? "active" : ""}`}
            to="/schedules"
          >
            Planifications
          </Link>
          <Link
            className={`nav-tab ${currentPath === "/services" ? "active" : ""}`}
            to="/services"
          >
            Services
          </Link>
        </nav>
      </header>

      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<FlowList />} />
          <Route path="/flows/:flowId" element={<FlowDetailPage />} />
          <Route path="/flows/:flowId/executions/:execId" element={<ExecutionDetailPage />} />
          <Route path="/schedules" element={<SchedulesListPage />} />
          <Route path="/services" element={<ServicesListPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </div>
  );
}
