import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
      <AlertTriangle className="h-5 w-5 shrink-0 text-red-500" />
      <p className="flex-1 text-red-600 dark:text-red-400">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
