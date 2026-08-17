import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getJobs, retryJob, bulkCancelJobs } from "@/lib/api";
import type { Job } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/StatusBadge";
import { SkeletonTable } from "@/components/SkeletonTable";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { toast } from "sonner";
import { ListTodo, RotateCw, XCircle } from "lucide-react";

const FILTER_TABS = [
  { label: "All", value: "" },
  { label: "Pending", value: "pending" },
  { label: "Processing", value: "processing" },
  { label: "Failed", value: "failed" },
  { label: "Done", value: "done" },
] as const;

function getPollInterval(jobs: Job[] | undefined): number | false {
  if (!jobs) return false;
  const hasProcessing = jobs.some((j) => j.status === "processing");
  const hasPending = jobs.some((j) => j.status === "pending");
  if (hasProcessing) return 3_000;
  if (hasPending) return 10_000;
  return false;
}

export function JobsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const jobsQ = useQuery({
    queryKey: ["jobs", { status: statusFilter }],
    queryFn: () => getJobs(statusFilter ? { status: statusFilter } : undefined),
    refetchInterval: (query) => getPollInterval(query.state.data?.results),
  });

  const retryMutation = useMutation({
    mutationFn: (id: number) => retryJob(id),
    onSuccess: () => {
      toast.success("Job retry queued");
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const cancelMutation = useMutation({
    mutationFn: (ids: number[]) => bulkCancelJobs(ids),
    onSuccess: (data) => {
      toast.success(`${data.cancelled} job(s) cancelled`);
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const jobs = jobsQ.data?.results ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
      </div>

      {jobsQ.isError && (
        <ErrorBanner
          message={jobsQ.error?.message ?? "Failed to load jobs"}
          onRetry={() => jobsQ.refetch()}
        />
      )}

      {/* Filter Tabs */}
      <div className="flex gap-2">
        {FILTER_TABS.map((tab) => (
          <Button
            key={tab.value}
            variant={statusFilter === tab.value ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {jobsQ.isLoading ? (
        <SkeletonTable rows={8} cols={7} />
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={<ListTodo className="h-12 w-12" />}
          title="No jobs"
          description="Jobs will appear here when you perform actions."
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job: Job) => (
                <TableRow
                  key={job.id}
                  className="cursor-pointer"
                  onClick={() => {
                    setSelectedJob(job);
                    setDetailOpen(true);
                  }}
                >
                  <TableCell className="font-medium">{job.type}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {job.team_name ?? `#${job.provider_account_id}`}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={job.status} />
                  </TableCell>
                  <TableCell>
                    {job.attempts}/{job.max_attempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(job.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {job.status === "failed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          retryMutation.mutate(job.id);
                        }}
                        disabled={retryMutation.isPending}
                      >
                        <RotateCw className="mr-1 h-3 w-3" />
                        Retry
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Job Detail Dialog */}
      {selectedJob && (
        <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {selectedJob.type}{" "}
                <Badge variant="outline" className="ml-2">
                  #{selectedJob.id}
                </Badge>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <p>
                    <StatusBadge status={selectedJob.status} />
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Attempts</span>
                  <p>
                    {selectedJob.attempts}/{selectedJob.max_attempts}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Created</span>
                  <p>
                    {new Date(selectedJob.created_at).toLocaleString()}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Updated</span>
                  <p>
                    {new Date(selectedJob.updated_at).toLocaleString()}
                  </p>
                </div>
              </div>

              {selectedJob.payload_json && (
                <div>
                  <span className="text-muted-foreground">Payload</span>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted p-3 text-xs">
                    {(() => {
                      try {
                        return JSON.stringify(
                          JSON.parse(selectedJob.payload_json),
                          null,
                          2,
                        );
                      } catch {
                        return selectedJob.payload_json;
                      }
                    })()}
                  </pre>
                </div>
              )}

              {selectedJob.error_log && (
                <div>
                  <span className="text-muted-foreground">Error Log</span>
                  <pre className="mt-1 overflow-x-auto rounded bg-destructive/10 p-3 text-xs text-destructive">
                    {selectedJob.error_log}
                  </pre>
                </div>
              )}

              {selectedJob.status === "failed" && (
                <Button
                  onClick={() => {
                    retryMutation.mutate(selectedJob.id);
                    setDetailOpen(false);
                  }}
                  disabled={retryMutation.isPending}
                >
                  <RotateCw className="mr-2 h-4 w-4" />
                  Retry Job
                </Button>
              )}

              {(selectedJob.status === "pending" ||
                selectedJob.status === "failed") && (
                <Button
                  variant="destructive"
                  onClick={() => {
                    cancelMutation.mutate([selectedJob.id]);
                    setDetailOpen(false);
                  }}
                  disabled={cancelMutation.isPending}
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  Cancel Job
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
