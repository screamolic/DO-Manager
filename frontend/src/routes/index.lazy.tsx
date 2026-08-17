import { useQuery } from "@tanstack/react-query";
import { getServers, getAccounts, getCredentials, getJobs } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { QuotaBar } from "@/components/QuotaBar";
import { Server, Monitor, Key, Clock } from "lucide-react";

export function OverviewPage() {
  const serversQ = useQuery({
    queryKey: ["servers"],
    queryFn: () => getServers(),
    refetchInterval: 10_000,
  });
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });
  const tokensQ = useQuery({
    queryKey: ["credentials"],
    queryFn: () => getCredentials(),
    refetchInterval: 10_000,
  });
  const jobsQ = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJobs(),
    refetchInterval: 10_000,
  });

  const activeServers =
    serversQ.data?.filter((s) => s.status === "active").length ?? 0;
  const activeTokens =
    tokensQ.data?.filter((t) => t.status === "active").length ?? 0;
  const pendingJobs =
    jobsQ.data?.results.filter((j) => j.status === "pending").length ?? 0;

  const topQuotas = tokensQ.data
    ?.filter((t) => t.status === "active")
    .sort((a, b) => a.requests_remaining - b.requests_remaining)
    .slice(0, 5);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Overview</h1>

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Server className="h-5 w-5" />}
          label="Active Servers"
          value={activeServers}
          loading={serversQ.isLoading}
        />
        <StatCard
          icon={<Monitor className="h-5 w-5" />}
          label="Total Accounts"
          value={accountsQ.data?.length ?? 0}
          loading={accountsQ.isLoading}
        />
        <StatCard
          icon={<Key className="h-5 w-5" />}
          label="Active Tokens"
          value={activeTokens}
          loading={tokensQ.isLoading}
        />
        <StatCard
          icon={<Clock className="h-5 w-5" />}
          label="Pending Jobs"
          value={pendingJobs}
          loading={jobsQ.isLoading}
        />
      </div>

      {/* Recent Jobs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobsQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : jobsQ.data && jobsQ.data.results.length > 0 ? (
            <div className="divide-y">
              {jobsQ.data.results.slice(0, 5).map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <span className="font-medium">{job.type}</span>
                  <Badge variant="outline">
                    <StatusBadge status={job.status} />
                    <span className="ml-1.5">{job.status}</span>
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No recent jobs.</p>
          )}
        </CardContent>
      </Card>

      {/* Token Quota Bars */}
      <Card>
        <CardHeader>
          <CardTitle>Token Quota (Top 5 Lowest)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {tokensQ.isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : topQuotas && topQuotas.length > 0 ? (
            topQuotas.map((token) => (
              <div key={token.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span>{token.label}</span>
                  <span className="text-muted-foreground">
                    {token.requests_remaining} / {token.rate_limit_hourly}
                  </span>
                </div>
                <QuotaBar
                  remaining={token.requests_remaining}
                  limit={token.rate_limit_hourly}
                />
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No tokens found.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className="text-3xl font-bold">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}
