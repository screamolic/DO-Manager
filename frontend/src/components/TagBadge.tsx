import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function TagBadge({
  tag,
  onRemove,
}: {
  tag: string;
  onRemove?: () => void;
}) {
  return (
    <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-xs">
      {tag}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 rounded-full hover:bg-muted-foreground/20"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </Badge>
  );
}
