import { useQuery } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { getNotifications } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Bell,
  ChevronRight,
  User,
} from "lucide-react";
import {
  useLocation,
} from "@tanstack/react-router";

function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground">
      <span
        className="cursor-pointer hover:text-foreground"
        onClick={() => window.history.pushState({}, "", "/")}
      >
        Dashboard
      </span>
      {segments.map((seg, i) => (
        <span key={seg} className="flex items-center gap-1">
          <ChevronRight className="h-3 w-3" />
          <span
            className={
              i === segments.length - 1
                ? "font-medium text-foreground"
                : "cursor-pointer hover:text-foreground"
            }
            onClick={() => {
              const path = "/" + segments.slice(0, i + 1).join("/");
              window.history.pushState({}, "", path);
            }}
          >
            {seg}
          </span>
        </span>
      ))}
    </nav>
  );
}

function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const notifQ = useQuery({
    queryKey: ["notifications"],
    queryFn: () => getNotifications(),
    refetchInterval: 30_000,
  });

  const notifications = notifQ.data ?? [];
  const unread = notifications.length;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={() => setOpen(!open)}
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border bg-popover shadow-lg">
          <div className="border-b px-3 py-2 text-sm font-medium">
            Notifications
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No notifications
              </div>
            ) : (
              notifications.slice(0, 15).map((n, idx) => (
                <div
                  key={`${n.created_at}-${idx}`}
                  className="border-b px-3 py-2 text-xs last:border-0 hover:bg-muted/50"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{n.action}</span>
                    <span className="text-muted-foreground">
                      {new Date(n.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mt-0.5 text-muted-foreground">
                    {n.actor || n.target_type || "-"}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Topbar() {
  return (
    <header className="flex h-14 items-center justify-between border-b px-6">
      <Breadcrumbs />
      <div className="flex items-center gap-2">
        <NotificationCenter />
        <Button variant="ghost" size="icon">
          <User className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
