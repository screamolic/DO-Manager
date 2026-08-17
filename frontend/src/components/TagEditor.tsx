import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagBadge } from "@/components/TagBadge";
import { toast } from "sonner";

export function TagEditor({
  tags,
}: {
  serverId?: number;
  tags: string | null;
}) {
  const [tagList, setTagList] = useState<string[]>(() => {
    if (!tags) return [];
    try {
      return JSON.parse(tags);
    } catch {
      return [tags];
    }
  });
  const [newTag, setNewTag] = useState("");

  function addTag() {
    const trimmed = newTag.trim().toLowerCase();
    if (!trimmed) return;
    if (tagList.includes(trimmed)) {
      toast.info("Tag already exists");
      return;
    }
    setTagList((prev) => [...prev, trimmed]);
    setNewTag("");
    toast.success("Tag added (local)");
  }

  function removeTag(tag: string) {
    setTagList((prev) => prev.filter((t) => t !== tag));
    toast.success("Tag removed (local)");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {tagList.length === 0 ? (
          <span className="text-sm text-muted-foreground">No tags</span>
        ) : (
          tagList.map((tag) => (
            <TagBadge key={tag} tag={tag} onRemove={() => removeTag(tag)} />
          ))
        )}
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="Add tag..."
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          className="h-8 w-48 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={addTag}
          disabled={!newTag.trim()}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
