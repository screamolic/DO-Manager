import { Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";

export default function App() {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar />
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
      <Toaster
        richColors
        closeButton
        position="bottom-right"
        duration={4000}
      />
    </div>
  );
}
