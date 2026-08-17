import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

export function QuotaBar({
  remaining,
  limit,
}: {
  remaining: number;
  limit: number;
}) {
  const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  const isLow = pct < 10;
  const isWarning = pct >= 10 && pct < 25;

  return (
    <div className="flex items-center gap-2">
      <Progress
        value={pct}
        className={cn(
          "h-2",
          isLow && "[&>div]:bg-red-500",
          isWarning && "[&>div]:bg-yellow-500",
        )}
      />
      <span
        className={cn(
          "min-w-[3rem] text-right text-xs tabular-nums",
          isLow && "font-medium text-red-500",
          isWarning && "text-yellow-500",
          !isLow && !isWarning && "text-muted-foreground",
        )}
      >
        {pct}%
      </span>
    </div>
  );
}
