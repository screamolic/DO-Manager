import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getCredentials, createCredential, updateCredential, syncQuota } from "@/lib/api";
import type { Credential } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QuotaBar } from "@/components/QuotaBar";
import { StatusBadge } from "@/components/StatusBadge";
import { SkeletonTable } from "@/components/SkeletonTable";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Key, Plus, RefreshCw, Ban, Trash2 } from "lucide-react";

const tokenSchema = z.object({
  label: z.string().min(1, "Label is required"),
  token: z.string().min(64, "Token must be at least 64 characters"),
  provider_id: z.string().min(1, "Provider is required"),
});

type TokenForm = z.infer<typeof tokenSchema>;

export function TokensPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedToken, setSelectedToken] = useState<Credential | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const tokensQ = useQuery({
    queryKey: ["credentials"],
    queryFn: () => getCredentials(),
  });

  const form = useForm<TokenForm>({
    resolver: zodResolver(tokenSchema),
    defaultValues: { label: "", token: "", provider_id: "digitalocean" },
  });

  const createMutation = useMutation({
    mutationFn: (data: TokenForm) => createCredential(data),
    onSuccess: () => {
      toast.success("Token created");
      setDialogOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { status?: string } }) =>
      updateCredential(id, data),
    onSuccess: () => {
      toast.success("Token updated");
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const syncMutation = useMutation({
    mutationFn: (id: number) => syncQuota(id),
    onSuccess: () => {
      toast.success("Quota synced");
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Tokens</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Token
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Token</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={form.handleSubmit((data) =>
                createMutation.mutate(data),
              )}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="label">Label *</Label>
                <Input id="label" {...form.register("label")} />
                {form.formState.errors.label && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.label.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="token">Token * (min 64 chars)</Label>
                <Input
                  id="token"
                  type="password"
                  {...form.register("token")}
                />
                {form.formState.errors.token && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.token.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider">Provider</Label>
                <Select
                  defaultValue="digitalocean"
                  onValueChange={(v: string) => form.setValue("provider_id", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="digitalocean">DigitalOcean</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Adding..." : "Add Token"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {tokensQ.isError && (
        <ErrorBanner
          message={tokensQ.error?.message ?? "Failed to load tokens"}
          onRetry={() => tokensQ.refetch()}
        />
      )}

      {tokensQ.isLoading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : tokensQ.data && tokensQ.data.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Account / Provider</TableHead>
                <TableHead>Quota</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokensQ.data.map((token: Credential) => (
                <TableRow
                  key={token.id}
                  className="cursor-pointer"
                  onClick={() => {
                    setSelectedToken(token);
                    setDetailOpen(true);
                  }}
                >
                  <TableCell className="font-medium">{token.label}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {token.provider_id}
                  </TableCell>
                  <TableCell className="min-w-[160px]">
                    <QuotaBar
                      remaining={token.requests_remaining}
                      limit={token.rate_limit_hourly}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={token.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {token.last_used_at
                      ? new Date(token.last_used_at).toLocaleString()
                      : "Never"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        syncMutation.mutate(token.id);
                      }}
                      disabled={syncMutation.isPending}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          icon={<Key className="h-12 w-12" />}
          title="No tokens"
          description="Add a DigitalOcean API token to manage servers."
          action={
            <DialogTrigger asChild>
              <Button>Add Token</Button>
            </DialogTrigger>
          }
        />
      )}

      {/* Token Detail Dialog */}
      {selectedToken && (
        <Dialog
          open={detailOpen}
          onOpenChange={setDetailOpen}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{selectedToken.label}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div>
                <span className="text-muted-foreground">Scopes</span>
                <p>{selectedToken.scopes || "-"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Status</span>
                <p>
                  <StatusBadge status={selectedToken.status} />
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>
                  {new Date(selectedToken.created_at).toLocaleDateString()}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Requests Remaining</span>
                <p>
                  {selectedToken.requests_remaining} /{" "}
                  {selectedToken.rate_limit_hourly}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    updateMutation.mutate({
                      id: selectedToken.id,
                      data: { status: "disabled" },
                    })
                  }
                >
                  <Ban className="mr-2 h-4 w-4" />
                  Disable
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    updateMutation.mutate({
                      id: selectedToken.id,
                      data: { status: "revoked" },
                    })
                  }
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Revoke
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
