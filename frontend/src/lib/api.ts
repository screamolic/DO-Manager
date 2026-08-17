/// <reference types="vite/client" />

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface Server {
  id: number;
  provider_account_id: number;
  name: string;
  region: string;
  size: string;
  image: string;
  status: string;
  tags: string | null;
  vcpus: number;
  memory: number;
  disk: number;
  ip: string | null;
  network_json: Record<string, unknown> | null;
  has_password: boolean;
  created_at: string;
  team_name: string | null;
  do_actions: DOAction[];
}

export interface DOAction {
  id: number;
  server_id: number;
  status: string;
  type: string;
  started_at: string;
  completed_at: string | null;
}

export interface Account {
  id: number;
  provider_id: string;
  team_name: string;
  email: string | null;
  notes: string | null;
  billing_status: string | null;
  server_count: number;
  token_count: number;
  account_balance_usd: number | null;
  month_to_date_usage_usd: number | null;
  balance_synced_at: string | null;
  created_at: string;
}

export interface Credential {
  id: number;
  provider_id: string;
  label: string;
  scopes: string;
  status: string;
  key_version: number;
  rate_limit_hourly: number;
  rate_limit_burst_min: number;
  requests_remaining: number;
  window_reset_at: string | null;
  last_probed_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface Job {
  id: number;
  provider_account_id: number;
  type: string;
  status: string;
  payload_json: string;
  error_log: string | null;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  team_name: string | null;
}

export interface Notification {
  source: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface AuditLog {
  id: number;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload_json: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------
const BASE_URL = import.meta.env.VITE_API_URL ?? "";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error ?? res.statusText, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Servers
export function getServers(params?: {
  account?: string;
  region?: string;
  status?: string;
  search?: string;
}): Promise<Server[]> {
  const qs = new URLSearchParams();
  if (params?.account) qs.set("account", params.account);
  if (params?.region) qs.set("region", params.region);
  if (params?.status) qs.set("status", params.status);
  if (params?.search) qs.set("search", params.search);
  const q = qs.toString();
  return request(`/api/servers${q ? `?${q}` : ""}`);
}

export function getServer(id: number): Promise<Server> {
  return request(`/api/servers/${id}`);
}

export function createServer(data: {
  account_id: number;
  name: string;
  region: string;
  size: string;
  image?: string;
  tags?: string[];
}): Promise<{ job_id: number; status: string }> {
  return request("/api/servers", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function bulkCreateServers(
  data: Array<{ account_id: number; name: string; region: string; size: string }>,
): Promise<{ jobs_count: number; jobs: { job_id: number; name: string }[] }> {
  return request("/api/servers/bulk", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function resizeServer(
  id: number,
  size: string,
): Promise<{ job_id: number; status: string }> {
  return request(`/api/servers/${id}/resize`, {
    method: "POST",
    body: JSON.stringify({ size }),
  });
}

export function snapshotServer(
  id: number,
  name?: string,
): Promise<{ job_id: number; status: string }> {
  return request(`/api/servers/${id}/snapshot`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function destroyServer(id: number): Promise<{ job_id: number; status: string }> {
  return request(`/api/servers/${id}`, { method: "DELETE" });
}

export function showPassword(
  id: number,
): Promise<{ password: string }> {
  return request(`/api/servers/${id}/show-password`, {
    method: "POST",
  });
}

// Accounts
export function getAccounts(): Promise<Account[]> {
  return request("/api/accounts");
}

export function createAccount(data: {
  team_name: string;
  email?: string;
  notes?: string;
}): Promise<{ id: number; team_name: string }> {
  return request("/api/accounts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateAccount(
  id: number,
  data: Partial<{
    team_name: string;
    email: string;
    notes: string;
    billing_status: string;
  }>,
): Promise<{ id: number } & typeof data> {
  return request(`/api/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function syncBalance(
  id: number,
): Promise<{
  account_balance_usd: number | null;
  month_to_date_usage_usd: number | null;
  balance_synced_at: string;
}> {
  return request(`/api/accounts/${id}/sync-balance`, { method: "POST" });
}

// Credentials
export function getCredentials(): Promise<Credential[]> {
  return request("/api/credentials");
}

export function createCredential(data: {
  provider_id: string;
  label: string;
  token: string;
  scopes?: string;
}): Promise<{ id: number; label: string; scopes: string; status: string }> {
  return request("/api/credentials", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateCredential(
  id: number,
  data: { label?: string; status?: string },
): Promise<{ id: number } & typeof data> {
  return request(`/api/credentials/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function syncQuota(
  id: number,
): Promise<{ requests_remaining: number | null; window_reset_at: string | null }> {
  return request(`/api/credentials/${id}/sync-quota`, { method: "POST" });
}

// Jobs
export function getJobs(params?: {
  status?: string;
  account_id?: string;
  type?: string;
  offset?: string;
}): Promise<{ results: Job[]; offset: number; limit: number }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.account_id) qs.set("account_id", params.account_id);
  if (params?.type) qs.set("type", params.type);
  if (params?.offset) qs.set("offset", params.offset);
  const q = qs.toString();
  return request(`/api/jobs${q ? `?${q}` : ""}`);
}

export function retryJob(id: number): Promise<{ id: number; status: string }> {
  return request(`/api/jobs/${id}/retry`, { method: "POST" });
}

export function bulkCancelJobs(jobIds: number[]): Promise<{ cancelled: number }> {
  return request("/api/jobs/bulk-cancel", {
    method: "POST",
    body: JSON.stringify({ job_ids: jobIds }),
  });
}

// Notifications
export function getNotifications(): Promise<Notification[]> {
  return request("/api/notifications");
}
