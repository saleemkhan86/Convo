import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { CallProvider } from "./lib/calls";
import { RealtimeProvider } from "./lib/realtime";
import { EmailAuthPage, PhoneAuthPage } from "./pages/AuthPages";
import { ConnectIdentityPage } from "./pages/ConnectIdentityPage";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { WelcomePage } from "./pages/WelcomePage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <FullScreenLoader />;
  if (status === "signed-out") return <Navigate to="/welcome" replace state={{ from: location }} />;
  return <RealtimeProvider><CallProvider>{children}</CallProvider></RealtimeProvider>;
}

function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <FullScreenLoader />;
  if (status === "signed-in") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function FullScreenLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-8 w-8 text-iris-500" />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route
        path="/welcome"
        element={<RedirectIfAuthed><WelcomePage /></RedirectIfAuthed>}
      />
      <Route path="/auth/phone" element={<RedirectIfAuthed><PhoneAuthPage /></RedirectIfAuthed>} />
      <Route path="/auth/email" element={<RedirectIfAuthed><EmailAuthPage /></RedirectIfAuthed>} />
      <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
      <Route path="/settings/connect-email" element={<RequireAuth><ConnectIdentityPage channel="email" /></RequireAuth>} />
      <Route path="/settings/connect-phone" element={<RequireAuth><ConnectIdentityPage channel="phone" /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
