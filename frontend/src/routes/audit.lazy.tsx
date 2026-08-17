import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getNotifications } from "@/lib/api";
import type { Notification } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { SkeletonTable } from "@/components/SkeletonTable";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { ClipboardList, ChevronLeft, ChevronRight } from "lucide-react";

const ITEMS_PER_PAGE = 25;

export function AuditPage() {
  const [page, setPage] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const auditQ = useQuery({
    queryKey: ["audit"],
    queryFn: () => getNotifications(),
  });

  if (auditQ.isError) {
    return (
      <ErrorBanner
        message={auditQ.error?.message ?? "Failed to load audit log"}
        onRetry={() => auditQ.refetch()}
      />
    );
  }

  const entries = (auditQ.data ?? []).filter((entry: Notification) => {
    if (typeFilter !== "all" && entry.target_type !== typeFilter) return false;
    const created = new Date(entry.created_at);
    if (dateFrom && created < new Date(dateFrom)) return false;
    if (dateTo && created > new Date(dateTo + "T23:59:59")) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(entries.length / ITEMS_PER_PAGE));
  const paginated = entries.slice(
    page * ITEMS_PER_PAGE,
    (page + 1) * ITEMS_PER_PAGE,
  );

  const targetTypes = auditQ.data
    ? [...new Set(auditQ.data.map((e) => e.target_type).filter(Boolean))]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={typeFilter} onValueChange={(v: string) => { setTypeFilter(v); setPage(0); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Target Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {targetTypes.map((t) => (
              <SelectItem key={t} value={t!}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
          className="w-40"
          placeholder="From"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
          className="w-40"
          placeholder="To"
        />
      </div>

      {auditQ.isLoading ? (
        <SkeletonTable rows={10} cols={5} />
      ) : paginated.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-12 w-12" />}
          title="No audit entries"
          description="Audit log entries will appear here."
        />
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.map((entry: Notification, idx: number) => (
                  <TableRow key={`${entry.created_at}-${idx}`}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(entry.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium">{entry.actor || "-"}</TableCell>
                    <TableCell>{entry.action}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {entry.target_type ?? "-"}
                      </Badge>
                      {entry.target_id && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          #{entry.target_id}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {entry.payload_json ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {(page * ITEMS_PER_PAGE) + 1}–
              {Math.min((page + 1) * ITEMS_PER_PAGE, entries.length)} of{" "}
              {entries.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
