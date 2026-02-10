import { Routes, Route, useLocation, Navigate, Link } from "react-router-dom";
import { FlowList } from "./pages/flow-list";
import { FlowDetailPage } from "./pages/flow-detail";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ServicesListPage } from "./pages/services-list";
import { ErrorBoundary } from "./components/error-boundary";
import { useWebSocketInit } from "./hooks/use-websocket";

export function App() {
  const location = useLocation();

  useWebSocketInit();

  const isServicesActive = location.pathname === "/services";

  return (
    <div className="container">
      <header>
        <h1>
          <Link to="/" className="logo-link">
            <span>Open</span>Flows
          </Link>
        </h1>
        <nav className="main-nav">
          <Link className={`nav-tab ${!isServicesActive ? "active" : ""}`} to="/">
            Flows
          </Link>
          <Link className={`nav-tab ${isServicesActive ? "active" : ""}`} to="/services">
            Services
          </Link>
        </nav>
      </header>

      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<FlowList />} />
          <Route path="/flows/:flowId" element={<FlowDetailPage />} />
          <Route path="/flows/:flowId/executions/:execId" element={<ExecutionDetailPage />} />
          <Route path="/services" element={<ServicesListPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </div>
  );
}
