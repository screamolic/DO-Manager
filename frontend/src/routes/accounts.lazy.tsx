import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getAccounts, syncBalance } from "@/lib/api";
import type { Account } from "@/lib/api";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonTable } from "@/components/SkeletonTable";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Building2,
  RefreshCw,
  Plus,
  AlertTriangle,
} from "lucide-react";

const accountSchema = z.object({
  team_name: z.string().min(1, "Team name is required"),
  email: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
});

type AccountForm = z.infer<typeof accountSchema>;

export function AccountsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });

  const form = useForm<AccountForm>({
    resolver: zodResolver(accountSchema),
    defaultValues: { team_name: "", email: "", notes: "" },
  });

  const syncMutation = useMutation({
    mutationFn: (id: number) => syncBalance(id),
    onSuccess: () => {
      toast.success("Balance synced");
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Accounts</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Account</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={form.handleSubmit(async (data) => {
                // In a real app, this would call createAccount
                toast.success(`Account "${data.team_name}" created`);
                setDialogOpen(false);
                form.reset();
              })}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="team_name">Team Name *</Label>
                <Input id="team_name" {...form.register("team_name")} />
                {form.formState.errors.team_name && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.team_name.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" {...form.register("email")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Input id="notes" {...form.register("notes")} />
              </div>
              <Button type="submit" className="w-full">
                Create Account
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {accountsQ.isError && (
        <ErrorBanner
          message={accountsQ.error?.message ?? "Failed to load accounts"}
          onRetry={() => accountsQ.refetch()}
        />
      )}

      {accountsQ.isLoading ? (
        <SkeletonTable rows={6} cols={7} />
      ) : accountsQ.data && accountsQ.data.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Servers</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>MTD Usage</TableHead>
                <TableHead>Last Synced</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accountsQ.data.map((account: Account) => (
                <TableRow
                  key={account.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedAccount(account)}
                >
                  <TableCell className="font-medium">
                    {account.team_name}
                  </TableCell>
                  <TableCell>{account.server_count}</TableCell>
                  <TableCell>{account.token_count}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {account.account_balance_usd !== null &&
                        account.account_balance_usd < 15 && (
                          <AlertTriangle className="h-4 w-4 text-destructive" />
                        )}
                      <span
                        className={
                          account.account_balance_usd !== null &&
                          account.account_balance_usd < 15
                            ? "font-medium text-destructive"
                            : ""
                        }
                      >
                        {account.account_balance_usd !== null
                          ? `$${account.account_balance_usd.toFixed(2)}`
                          : "-"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {account.month_to_date_usage_usd !== null
                      ? `$${account.month_to_date_usage_usd.toFixed(2)}`
                      : "-"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {account.balance_synced_at
                      ? new Date(account.balance_synced_at).toLocaleString()
                      : "Never"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        syncMutation.mutate(account.id);
                      }}
                      disabled={syncMutation.isPending}
                    >
                      <RefreshCw
                        className={`mr-1 h-3 w-3 ${
                          syncMutation.isPending ? "animate-spin" : ""
                        }`}
                      />
                      Sync
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          icon={<Building2 className="h-12 w-12" />}
          title="No accounts"
          description="Add a DigitalOcean account to get started."
          action={
            <DialogTrigger asChild>
              <Button>Add Account</Button>
            </DialogTrigger>
          }
        />
      )}

      {/* Account Detail Dialog */}
      {selectedAccount && (
        <Dialog
          open={!!selectedAccount}
          onOpenChange={(open: boolean) => !open && setSelectedAccount(null)}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{selectedAccount.team_name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Email</span>
                  <p>{selectedAccount.email ?? "-"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Billing Status</span>
                  <p>{selectedAccount.billing_status ?? "-"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Servers</span>
                  <p>{selectedAccount.server_count}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Tokens</span>
                  <p>{selectedAccount.token_count}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Balance</span>
                  <p>
                    {selectedAccount.account_balance_usd !== null
                      ? `$${selectedAccount.account_balance_usd.toFixed(2)}`
                      : "-"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">MTD Usage</span>
                  <p>
                    {selectedAccount.month_to_date_usage_usd !== null
                      ? `$${selectedAccount.month_to_date_usage_usd.toFixed(2)}`
                      : "-"}
                  </p>
                </div>
              </div>
              {selectedAccount.notes && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Notes</span>
                  <p>{selectedAccount.notes}</p>
                </div>
              )}
              <Button
                onClick={() => syncMutation.mutate(selectedAccount.id)}
                disabled={syncMutation.isPending}
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${
                    syncMutation.isPending ? "animate-spin" : ""
                  }`}
                />
                Sync Now
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
