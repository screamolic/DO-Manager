import { useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getServer, showPassword, resizeServer, snapshotServer, destroyServer } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { CopyButton } from "@/components/CopyButton";
import { TagEditor } from "@/components/TagEditor";
import { SkeletonCard } from "@/components/SkeletonCard";
import { ErrorBanner } from "@/components/ErrorBanner";
import { toast } from "sonner";
import {
  HardDrive,
  Cpu,
  MemoryStick,
  Eye,
  RotateCw,
  Camera,
  Trash2,
  Maximize,
} from "lucide-react";

export function ServerDetailPage() {
  const { id } = useParams({ from: "/servers/$id" });
  const serverId = Number(id);
  const queryClient = useQueryClient();
  const [showPw, setShowPw] = useState(false);
  const [password, setPassword] = useState<string | null>(null);

  const serverQ = useQuery({
    queryKey: ["server", serverId],
    queryFn: () => getServer(serverId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasActiveAction = data.do_actions?.some(
        (a) => a.status === "in-progress" || a.status === "pending",
      );
      return hasActiveAction ? 5_000 : false;
    },
  });

  const showPwMutation = useMutation({
    mutationFn: () => showPassword(serverId),
    onSuccess: (data) => {
      setPassword(data.password);
      setShowPw(true);
      toast.success("Password retrieved (shown once)");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const resizeMutation = useMutation({
    mutationFn: (size: string) => resizeServer(serverId, size),
    onSuccess: () => {
      toast.success("Resize job queued");
      queryClient.invalidateQueries({ queryKey: ["server", serverId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const snapshotMutation = useMutation({
    mutationFn: () => snapshotServer(serverId),
    onSuccess: () => {
      toast.success("Snapshot job queued");
      queryClient.invalidateQueries({ queryKey: ["server", serverId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const destroyMutation = useMutation({
    mutationFn: () => destroyServer(serverId),
    onSuccess: () => {
      toast.success("Destroy job queued");
      queryClient.invalidateQueries({ queryKey: ["server", serverId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (serverQ.isLoading) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
      </div>
    );
  }

  if (serverQ.isError) {
    return (
      <ErrorBanner
        message={serverQ.error?.message ?? "Failed to load server"}
        onRetry={() => serverQ.refetch()}
      />
    );
  }

  const server = serverQ.data!;
  const actionsInProgress =
    server.do_actions?.filter(
      (a) => a.status === "in-progress" || a.status === "pending",
    ).length ?? 0 > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{server.name}</h1>
          <p className="text-sm text-muted-foreground">ID: {server.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={server.status} />
          {actionsInProgress && (
            <Badge variant="secondary" className="animate-pulse">
              Actions in progress...
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>Server Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">IP</span>
              <div className="flex items-center gap-1">
                <span>{server.ip ?? "-"}</span>
                {server.ip && <CopyButton text={server.ip} />}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Region</span>
              <span>{server.region}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Account</span>
              <span>{server.team_name ?? "-"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Image</span>
              <span>{server.image}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(server.created_at).toLocaleDateString()}</span>
            </div>
          </CardContent>
        </Card>

        {/* Specs Card */}
        <Card>
          <CardHeader>
            <CardTitle>Specifications</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span>vCPUs</span>
              </div>
              <span>{server.vcpus}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MemoryStick className="h-4 w-4 text-muted-foreground" />
                <span>Memory</span>
              </div>
              <span>{server.memory} MB</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <span>Disk</span>
              </div>
              <span>{server.disk} GB</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Maximize className="h-4 w-4 text-muted-foreground" />
                <span>Size</span>
              </div>
              <span>{server.size}</span>
            </div>
          </CardContent>
        </Card>

        {/* Actions Card */}
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => resizeMutation.mutate("s-2vcpu-4gb")}
              disabled={resizeMutation.isPending}
            >
              <Maximize className="mr-2 h-4 w-4" />
              Resize
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => snapshotMutation.mutate()}
              disabled={snapshotMutation.isPending}
            >
              <Camera className="mr-2 h-4 w-4" />
              Snapshot
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => resizeMutation.mutate(server.size)}
              disabled={resizeMutation.isPending}
            >
              <RotateCw className="mr-2 h-4 w-4" />
              Reboot
            </Button>
            <Button
              variant="destructive"
              className="w-full justify-start"
              onClick={() => {
                if (confirm("Are you sure you want to destroy this server?")) {
                  destroyMutation.mutate();
                }
              }}
              disabled={destroyMutation.isPending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Destroy
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Password Section */}
      {server.has_password && (
        <Card>
          <CardHeader>
            <CardTitle>Root Password</CardTitle>
          </CardHeader>
          <CardContent>
            {showPw && password ? (
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted px-3 py-1.5 text-sm">
                  {password}
                </code>
                <CopyButton text={password} />
                <Badge variant="secondary">Password retrieved</Badge>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() => showPwMutation.mutate()}
                disabled={showPwMutation.isPending}
              >
                <Eye className="mr-2 h-4 w-4" />
                Show Password
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Tags */}
      <Card>
        <CardHeader>
          <CardTitle>Tags</CardTitle>
        </CardHeader>
        <CardContent>
          <TagEditor serverId={serverId} tags={server.tags} />
        </CardContent>
      </Card>

      {/* Network Info */}
      {server.network_json && (
        <Card>
          <CardHeader>
            <CardTitle>Network</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded bg-muted p-4 text-xs">
              {JSON.stringify(server.network_json, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* DO Actions History */}
      <Card>
        <CardHeader>
          <CardTitle>Action History</CardTitle>
        </CardHeader>
        <CardContent>
          {server.do_actions && server.do_actions.length > 0 ? (
            <div className="divide-y text-sm">
              {server.do_actions.map((action) => (
                <div
                  key={action.id}
                  className="flex items-center justify-between py-2"
                >
                  <div>
                    <span className="font-medium">{action.type}</span>
                    <span className="ml-2 text-muted-foreground">
                      {new Date(action.started_at).toLocaleString()}
                    </span>
                  </div>
                  <StatusBadge status={action.status} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No actions yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
