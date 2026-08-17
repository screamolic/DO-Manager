import { cn } from "@/lib/utils";

const statusConfig: Record<string, { color: string; label: string }> = {
  active: { color: "bg-green-500", label: "●" },
  transitioning: { color: "bg-yellow-500", label: "○" },
  "in-progress": { color: "bg-yellow-500", label: "○" },
  pending: { color: "bg-yellow-500", label: "○" },
  processing: { color: "bg-blue-500", label: "◇" },
  failed: { color: "bg-red-500", label: "⚠" },
  error: { color: "bg-red-500", label: "⚠" },
  done: { color: "bg-green-500", label: "●" },
  completed: { color: "bg-green-500", label: "●" },
  off: { color: "bg-gray-400", label: "◇" },
  disabled: { color: "bg-gray-400", label: "◇" },
  revoked: { color: "bg-red-500", label: "⚠" },
  cancelled: { color: "bg-gray-400", label: "◇" },
  queued: { color: "bg-blue-500", label: "◇" },
  new: { color: "bg-blue-500", label: "◇" },
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const config = statusConfig[status] ?? {
    color: "bg-gray-400",
    label: "◇",
  };
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs", className)}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          config.color,
        )}
      />
      <span className="sr-only">{status}</span>
    </span>
  );
}
