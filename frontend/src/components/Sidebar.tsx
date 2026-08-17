import { useStore } from "@/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  Server,
  Building2,
  Key,
  ListTodo,
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import { Link, useLocation } from "@tanstack/react-router";

const navItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/" },
  { label: "Servers", icon: Server, href: "/servers" },
  { label: "Accounts", icon: Building2, href: "/accounts" },
  { label: "Tokens", icon: Key, href: "/tokens" },
  { label: "Jobs", icon: ListTodo, href: "/jobs" },
  { label: "Audit", icon: ClipboardList, href: "/audit" },
];

export function Sidebar() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggle = useStore((s) => s.toggleSidebar);
  const location = useLocation();

  // Token warning widget (placeholder — would connect to real data)
  const tokenWarning = false;

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-background transition-all duration-200",
        collapsed ? "w-16" : "w-56",
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b px-4">
        <div className="flex items-center gap-2 font-semibold">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
            DO
          </div>
          {!collapsed && <span className="text-sm">DO Manager</span>}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const active = location.pathname === item.href;
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                "inline-flex items-center justify-start whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-9 w-full",
                active ? "bg-secondary text-secondary-foreground hover:bg-secondary/80" : "hover:bg-accent hover:text-accent-foreground",
                collapsed ? "px-2" : "px-3",
              )}
            >
              <item.icon className={cn("h-4 w-4 shrink-0", collapsed ? "mx-auto" : "mr-2")} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Warning Widget */}
      {tokenWarning && !collapsed && (
        <div className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-500" />
          <span className="text-yellow-600 dark:text-yellow-400">
            Token quota low
          </span>
        </div>
      )}

      {/* Collapse toggle */}
      <div className="border-t p-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-full"
          onClick={toggle}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      </div>
    </aside>
  );
}
