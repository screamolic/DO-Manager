import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getServers, getAccounts } from "@/lib/api";
import type { Server, Account } from "@/lib/api";
import { useStore } from "@/store";
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
import { StatusBadge } from "@/components/StatusBadge";
import { TagBadge } from "@/components/TagBadge";
import { CopyButton } from "@/components/CopyButton";
import { QuickActionDropdown } from "@/components/QuickActionDropdown";
import { SkeletonTable } from "@/components/SkeletonTable";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Search, Server as ServerIcon } from "lucide-react";

export function ServersPage() {
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [regionFilter, setRegionFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const selectedRows = useStore((s) => s.selectedRows["servers"] ?? new Set());
  const toggleRow = useStore((s) => s.toggleRow);

  const params: Record<string, string> = {};
  if (accountFilter !== "all") params.account = accountFilter;
  if (regionFilter !== "all") params.region = regionFilter;
  if (statusFilter !== "all") params.status = statusFilter;
  if (search) params.search = search;

  const serversQ = useQuery({
    queryKey: ["servers", params],
    queryFn: () => getServers(params),
  });

  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });

  // Extract unique regions and statuses from data
  const servers = serversQ.data ?? [];
  const regions = [...new Set(servers.map((s) => s.region))];
  const statuses = [...new Set(servers.map((s) => s.status))];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Servers</h1>
        <Button>
          <ServerIcon className="mr-2 h-4 w-4" />
          Create Server
        </Button>
      </div>

      {serversQ.isError && (
        <ErrorBanner
          message={serversQ.error?.message ?? "Failed to load servers"}
          onRetry={() => serversQ.refetch()}
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={accountFilter} onValueChange={setAccountFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Accounts</SelectItem>
            {accountsQ.data?.map((a: Account) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.team_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={regionFilter} onValueChange={setRegionFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Region" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Regions</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bulk actions bar */}
      {selectedRows.size > 0 && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-4 py-2 text-sm">
          <span className="font-medium">{selectedRows.size} selected</span>
          <Button size="sm" variant="outline">
            Power Off
          </Button>
          <Button size="sm" variant="outline">
            Reboot
          </Button>
        </div>
      )}

      {/* Table */}
      {serversQ.isLoading ? (
        <SkeletonTable rows={8} cols={9} />
      ) : servers.length === 0 ? (
        <EmptyState
          icon={<ServerIcon className="h-12 w-12" />}
          title="No servers yet"
          description="Create your first server to get started."
          action={<Button>Create Server</Button>}
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="accent-foreground"
                    checked={selectedRows.size === servers.length && servers.length > 0}
                    onChange={() => {
                      if (selectedRows.size === servers.length) {
                        useStore.getState().clearSelectedRows("servers");
                      } else {
                        useStore
                          .getState()
                          .setSelectedRows(
                            "servers",
                            new Set(servers.map((s) => s.id)),
                          );
                      }
                    }}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((server: Server) => (
                <TableRow
                  key={server.id}
                  data-state={selectedRows.has(server.id) ? "selected" : undefined}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      className="accent-foreground"
                      checked={selectedRows.has(server.id)}
                      onChange={() => toggleRow("servers", server.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <a
                      href={`/servers/${server.id}`}
                      className="hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        window.history.pushState({}, "", `/servers/${server.id}`);
                        window.dispatchEvent(new PopStateEvent("popstate"));
                      }}
                    >
                      {server.name}
                    </a>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {server.tags
                        ? JSON.parse(server.tags).map((tag: string) => (
                            <TagBadge key={tag} tag={tag} />
                          ))
                        : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {server.team_name ?? "-"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {server.region}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {server.size}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">
                        {server.ip ?? "-"}
                      </span>
                      {server.ip && <CopyButton text={server.ip} />}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={server.status} />
                  </TableCell>
                  <TableCell>
                    <QuickActionDropdown serverId={server.id} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
