# PRD: DO Manager
### Platform Manajemen Multi-Akun & Multi-Token DigitalOcean via Cloudflare

| | |
|---|---|
| **Versi** | 1.0 |
| **Tanggal** | 1 Juli 2026 |
| **Status** | Draft |
| **Owner** | Andy |

---

## 1. Ringkasan & Latar Belakang

Andy mengelola beberapa akun DigitalOcean untuk keperluan infrastruktur marketing & automation (n8n, NocoDB, 9Router, dsb). Saat ini pengelolaan droplet dilakukan manual lewat DO Console per akun, tanpa visibilitas terpusat atas seluruh server, tanpa tracking pemakaian rate limit API per token, dan tanpa mekanisme antrian saat perlu membuat/mengubah banyak droplet sekaligus.

DO Manager adalah dashboard + API relay internal yang:
- Menyatukan visibilitas seluruh droplet dari banyak akun DO dalam satu tempat.
- Mengelola banyak API token dengan rotasi otomatis berbasis sisa kuota rate-limit.
- Menjalankan operasi (create/resize/snapshot/destroy) secara asynchronous lewat job queue, sehingga aman dieksekusi secara batch tanpa membanjiri satu token.
- Menyimpan seluruh kredensial terenkripsi, tidak pernah plaintext.

Bukan pengganti DO Console — ini adalah **control plane tambahan** yang fokus pada skenario multi-akun yang tidak dilayani baik oleh Console DO (yang didesain single-account).

---

## 2. Tujuan & Non-Tujuan

### Tujuan (Goals)
1. Satu dashboard untuk melihat seluruh droplet dari semua akun DO yang dikelola.
2. Membuat/mengubah droplet dalam jumlah banyak tanpa manual klik satu-satu di Console.
3. Rate limit API (5000/jam & 250/menit per token) tidak pernah membuat operasi gagal diam-diam — sistem otomatis pilih token dengan kuota tersisa & retry dengan backoff.
4. Kredensial token tersimpan aman (encrypted at rest).
5. Riwayat lengkap: siapa/apa yang memicu perubahan apa, kapan, hasilnya apa.

### Non-Tujuan (Out of Scope untuk v1)
- Bukan billing/cost management tool (tidak menghitung estimasi biaya DO).
- Bukan monitoring infrastruktur mendalam (CPU/RAM/disk droplet) — cukup status dasar dari DO API.
- Tidak mengelola resource DO selain Droplets di v1 (Load Balancer, Spaces, Kubernetes menyusul di fase lanjutan bila dibutuhkan).
- Tidak menangani proxy/IP untuk akun media sosial — di luar domain proyek ini.

---

## 3. Target Pengguna

Single-user internal tool (Andy sebagai admin/operator). Didesain agar bisa ditambah 1-2 kolaborator kepercayaan di kemudian hari lewat Cloudflare Access, tapi tidak perlu sistem role/permission kompleks di v1 — cukup satu tingkat akses admin.

---

## 4. Lingkup (Scope) — MVP

| Fitur | Termasuk MVP? |
|---|---|
| List & detail droplet lintas akun | ✅ |
| Create droplet (single & bulk) via job queue | ✅ |
| Resize, reboot, snapshot, destroy droplet | ✅ |
| Manajemen token (tambah/nonaktifkan, lihat sisa kuota) | ✅ |
| Manajemen akun/team DO | ✅ |
| Job queue monitor (lihat status, retry manual) | ✅ |
| Audit log | ✅ |
| Notifikasi Telegram (server down, token throttled, job gagal, saldo rendah) | ✅ |
| Cost estimation per size_slug (proyeksi biaya, bukan saldo aktual) | ⏳ Fase 2 |
| Throttling di level droplet (bandwidth/CPU via DO Monitoring API) | ⏳ Fase 2 |
| Multi-provider (Linode/Hetzner/Vultr) | ⏳ Fase 3 |
| Role & permission multi-user | ⏳ Fase 3 |

---

## 5. Arsitektur Sistem

```
┌─────────────────────────────────────────────────────────┐
│                  Cloudflare Worker (satu)                │
│                                                           │
│   ┌───────────────┐   ┌──────────────┐   ┌────────────┐ │
│   │ Static Assets  │   │  Hono API    │   │   queue()  │ │
│   │ (React SPA)    │   │  fetch()     │   │ scheduled()│ │
│   │ dist/          │◄──┤  /api/*      │   │  consumer  │ │
│   └───────────────┘   └──────┬───────┘   └─────┬──────┘ │
└──────────────────────────────┼──────────────────┼────────┘
                                │                  │
                     ┌──────────▼──────────┐   ┌───▼────────────┐
                     │   D1 (SQLite)        │   │ Cloudflare      │
                     │  servers, jobs,       │   │ Queues          │
                     │  credentials, dst.    │   │ (do-jobs)       │
                     └───────────────────────┘   └─────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │  DigitalOcean API    │
                     │  api.digitalocean.com│
                     └───────────────────────┘

Akses dashboard diproteksi Cloudflare Access (Zero Trust) di depan Worker.
```

**Kenapa satu Worker, bukan split:** tidak ada kebutuhan SSR/SEO (internal tool di balik login), jadi React SPA statis cukup dan bisa di-serve dari binding yang sama dengan API — satu `wrangler deploy`, satu tempat maintain.

**Komponen:**
- **Frontend:** React + Vite, di-build jadi static assets, di-serve Worker via `[assets]` binding.
- **Backend API:** Hono, jalan di `fetch()` handler yang sama.
- **Job processing:** Cloudflare Queues consumer (`queue()`), untuk operasi async ke DO API.
- **Scheduler:** Cron trigger (`scheduled()`) untuk sinkronisasi status action yang masih in-progress dan refresh status droplet berkala.
- **Database:** D1 (SQLite), skema lihat Bagian 6.
- **Auth:** Cloudflare Access, login via email OTP atau Google SSO — tidak perlu bikin sistem auth sendiri.

---

## 6. Skema Database

D1 (SQLite). Prinsip desain: `api_credentials` adalah unit rate-limit (bukan `provider_accounts`), karena DO membatasi per token, bukan per akun.

### ERD (ringkas)

```
providers ──1:N── api_credentials ──1:N── provider_accounts ──1:N── servers ──1:N── do_actions
                        │
                        └──1:N── rate_limit_events

provider_accounts ──1:N── job_queue
                            │
                            └── (payload berisi target server/droplet)

(semua tabel) ──N:1── audit_log (referensi longgar via target_type/target_id)
```

### Tabel

**`providers`** — daftar penyedia (future-proof untuk provider lain)
| Kolom | Tipe | Ket |
|---|---|---|
| id | TEXT PK | `'digitalocean'` |
| name | TEXT | |
| base_url | TEXT | |
| auth_type | TEXT | default `bearer` |

**`api_credentials`** — satu baris = satu token API
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| provider_id | TEXT FK | |
| label | TEXT | mis. `"akun-utara-token1"` |
| token_encrypted | TEXT | ciphertext AES-GCM |
| token_iv | TEXT | IV enkripsi |
| scopes | TEXT | |
| status | TEXT | active / disabled / revoked |
| rate_limit_hourly | INTEGER | default 5000 |
| rate_limit_burst_min | INTEGER | default 250 |
| requests_remaining | INTEGER | sinkron dari header `ratelimit-remaining` |
| window_reset_at | INTEGER | unix epoch, dari header `ratelimit-reset` |
| last_used_at | TEXT | |

**`provider_accounts`** — satu baris = satu Team/akun DO
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| provider_id | TEXT FK | |
| credential_id | INTEGER FK | token default akun ini (nullable, bisa override per-job) |
| team_name | TEXT | |
| email | TEXT | |
| billing_status | TEXT | |
| account_balance_usd | REAL | saldo tersisa, sinkron dari DO Balance API |
| month_to_date_usage_usd | REAL | pemakaian bulan berjalan, sinkron dari DO Balance API |
| balance_synced_at | TEXT | kapan terakhir disinkron |
| notes | TEXT | |

**`servers`** — mirror droplet lokal
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| provider_account_id | INTEGER FK | |
| external_id | TEXT | droplet_id asli dari DO |
| name | TEXT | |
| region | TEXT | |
| size_slug | TEXT | |
| ip_address | TEXT | |
| status | TEXT | active/off/new/archive |
| tags_json | TEXT | |
| last_health_check_at | TEXT | |

**`do_actions`** — tracking operasi async DO
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| server_id | INTEGER FK | |
| do_action_id | TEXT | |
| type | TEXT | create/resize/snapshot/power_cycle |
| status | TEXT | in-progress/completed/errored |
| started_at / completed_at | TEXT | |

**`job_queue`** — antrian kerja sisi konsumen
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| provider_account_id | INTEGER FK | |
| type | TEXT | create_droplet/resize/delete/bulk_tag |
| payload_json | TEXT | |
| status | TEXT | pending/processing/done/failed |
| priority | INTEGER | |
| attempts | INTEGER | |
| next_retry_at | TEXT | |
| error_log | TEXT | |
| idempotency_key | TEXT UNIQUE | dibuat sekali saat job dibuat, dikirim ke DO API di tiap percobaan — lihat 15.1 |

**`rate_limit_events`** — audit token yang kena 429
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| credential_id | INTEGER FK | |
| endpoint | TEXT | |
| hit_at | TEXT | |
| retry_after_seconds | INTEGER | |

**`audit_log`** — jejak semua aksi penting
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| actor | TEXT | default `system` |
| action | TEXT | |
| target_type / target_id | TEXT | |
| payload_json | TEXT | |

*(DDL lengkap sudah tersedia di `schema.sql` dari iterasi sebelumnya — PRD ini merujuk skema yang sama, tidak diulang penuh di sini.)*

---

## 7. Spesifikasi API

| Method | Endpoint | Deskripsi |
|---|---|---|
| GET | `/api/servers` | List semua droplet lintas akun, dengan filter `?account_id=&status=&region=` |
| GET | `/api/servers/:id` | Detail satu droplet + riwayat action |
| POST | `/api/servers` | Buat job create droplet (single). Return `202` + `job_id` |
| POST | `/api/servers/bulk` | Buat banyak job sekaligus dari array payload |
| POST | `/api/servers/:id/resize` | Job resize |
| POST | `/api/servers/:id/snapshot` | Job snapshot |
| DELETE | `/api/servers/:id` | Job destroy |
| GET | `/api/accounts` | List akun DO + agregat (jumlah server, jumlah token aktif, saldo tersinkron terakhir) |
| POST | `/api/accounts` | Tambah akun DO baru |
| POST | `/api/accounts/:id/sync-balance` | Trigger sync manual saldo dari DO Balance API |
| GET | `/api/credentials` | List token (tanpa expose ciphertext), termasuk `requests_remaining` |
| POST | `/api/credentials` | Tambah token baru (di-encrypt server-side sebelum simpan) |
| PATCH | `/api/credentials/:id` | Ubah status (disable/enable/revoke) |
| GET | `/api/jobs` | List job_queue dengan filter status |
| POST | `/api/jobs/:id/retry` | Retry manual job yang failed |
| GET | `/api/audit-log` | List audit log dengan filter |
| GET | `/api/notifications` | Gabungan `audit_log` + `alerts_log` terbaru (15 event), untuk Notification Center |

Semua endpoint di belakang Cloudflare Access — tidak perlu auth layer tambahan di kode aplikasi.

---

## 8. UX/UI — Desain Layar

### Prinsip desain
Dashboard operasional, bukan produk konsumen. Prioritas: **kepadatan informasi** dan **kecepatan aksi** (bulk operations), bukan estetika showcase. Layout: sidebar kiri fixed + area konten kanan, pola umum admin dashboard.

### 8.1 Layout Global

```
┌────────────┬──────────────────────────────────────────────┐
│            │  Topbar: [Breadcrumb]        🔔³   [Andy ▾]    │
│  Sidebar   ├──────────────────────────────────────────────┤
│            │                                                │
│ ▸ Overview │              Area Konten Utama                │
│ ▸ Servers  │                                                │
│ ▸ Accounts │                                                │
│ ▸ Tokens   │                                                │
│ ▸ Jobs     │                                                │
│ ▸ Audit    │                                                │
│            │                                                │
│ [status:   │                                                │
│  3 token   │                                                │
│  hampir    │                                                │
│  habis ⚠]  │                                                │
└────────────┴──────────────────────────────────────────────┘
```

Sidebar punya indikator kecil di bawah (persistent warning widget) kalau ada token yang sisa kuotanya < 10% — supaya kelihatan dari halaman manapun tanpa harus buka menu Tokens. Ikon 🔔 di topbar adalah Notification Center (lihat subbagian "Toast & Notification Center" di akhir Bagian 8) — badge angka menunjukkan jumlah event belum dibaca.

### 8.2 Overview (halaman utama)

```
┌──────────────────────────────────────────────────────────┐
│  Overview                                                  │
│                                                              │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ │
│  │ 47 Servers│ │ 5 Accounts│ │ 12 Tokens │ │ 3 Job      │ │
│  │  Active   │ │           │ │  Active   │ │  Pending   │ │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘ │
│                                                              │
│  Job Queue Terkini                     [Lihat semua →]     │
│  ┌────────────────────────────────────────────────────┐   │
│  │ ● create_droplet  akun-utara   processing  2m lalu  │   │
│  │ ● resize          akun-timur   done        5m lalu  │   │
│  │ ● snapshot        akun-utara   failed  ⚠   12m lalu │   │
│  └────────────────────────────────────────────────────┘   │
│                                                              │
│  Kuota Token (10 dengan sisa terkecil)  [Lihat semua →]    │
│  ┌────────────────────────────────────────────────────┐   │
│  │ akun-utara-token1   ███░░░░░░░  620/5000   reset 22m│   │
│  │ akun-timur-token2   █████████░  4200/5000  reset 40m│   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

Tujuan halaman ini: dalam 3 detik Andy tahu "ada yang perlu diperhatikan atau tidak" — makanya job yang `failed` dan token yang hampir habis ditonjolkan (warna merah/kuning), bukan dikubur di tabel biasa.

### 8.3 Accounts (list)

```
┌───────────────────────────────────────────────────────────────────────┐
│  Accounts                                          [+ Add Account]     │
│  🔍 search                                                              │
│                                                                          │
│  Team              Servers  Tokens   Saldo         MTD Usage   Synced  │
│  akun-utara         18       3/3●    $142.30       $87.10      3m lalu │
│  akun-timur         12       2/2●    $9.80  ⚠      $210.40     3m lalu │
│  akun-selatan       9        1/2 ⚠   $310.00       $44.00      3m lalu │
│  akun-riset         8        1/1●    $58.90        $12.30      3m lalu │
│                                                                          │
│  Klik baris → detail akun (daftar server milik akun, daftar token,      │
│  riwayat sync saldo, tombol "Sync sekarang")                            │
└───────────────────────────────────────────────────────────────────────┘
```

Kolom **Saldo** dan **MTD Usage** diambil dari D1 (`account_balance_usd`, `month_to_date_usage_usd`), bukan live call ke DO tiap kali halaman dibuka — sync dilakukan cron tiap 30-60 menit lewat DO Balance API (`GET /v2/customers/my/balance`, butuh token dengan scope billing read). Saldo di bawah ambang tertentu (mis. < $15) ditandai ⚠ merah di kolom, sama seperti pola warning kuota token — konsisten dengan pattern visual yang sudah dipakai di Overview & Tokens.

Kolom **Tokens** menunjukkan jumlah token aktif vs total (mis. `1/2` berarti satu token disabled/revoked) — indikator cepat kalau ada token mati yang belum dibersihkan atau perlu ditambah.

### 8.4 Servers (list)

```
┌──────────────────────────────────────────────────────────┐
│  Servers                          [+ Create]  [Bulk ▾]     │
│  Filter: [Account ▾] [Region ▾] [Status ▾]  🔍 search      │
│                                                              │
│  ☐ Name          Account      Region  Size    Status   IP  │
│  ☐ n8n-prod-01    akun-utara   sgp1   2vCPU   ●active  ... │
│  ☐ nocodb-01      akun-utara   sgp1   1vCPU   ●active  ... │
│  ☐ worker-batch-3 akun-timur   nyc1   4vCPU   ○resizing... │
│  ...                                                        │
│                                                              │
│  [2 dipilih]  [Resize] [Snapshot] [Destroy] [Add tag]       │
└──────────────────────────────────────────────────────────┘
```

Checkbox multi-select + action bar muncul di bawah saat ada yang dipilih — ini yang menjawab kebutuhan "kelola banyak akun/server", bukan cuma CRUD satu-satu. Bulk create pakai modal terpisah dengan textarea/CSV paste untuk nama-nama server sekaligus.

### 8.5 Server Detail

```
┌──────────────────────────────────────────────────────────┐
│  ← Servers   /   n8n-prod-01                                │
│                                                              │
│  Status: ● active        Akun: akun-utara    Region: sgp1  │
│  IP: 128.199.x.x          Size: s-2vcpu-4gb                │
│                                                              │
│  [Resize]  [Reboot]  [Snapshot]  [Destroy]                 │
│                                                              │
│  Riwayat Action                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │ create    completed   1 Jul 08:12                    │   │
│  │ resize    completed   15 Jun 14:03                   │   │
│  │ snapshot  in-progress 1 Jul 09:40  (auto-refresh)     │   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### 8.6 Tokens (manajemen kredensial)

```
┌──────────────────────────────────────────────────────────┐
│  Tokens                                    [+ Add Token]   │
│                                                              │
│  Label              Akun         Kuota/jam      Status     │
│  akun-utara-token1  akun-utara   620/5000 ███░░  ●active   │
│  akun-utara-token2  akun-utara   4890/5000█████  ●active   │
│  akun-timur-token1  akun-timur   0/5000    ░░░░  ⚠ limit   │
│                                                              │
│  Klik baris → detail: scope, tanggal dibuat, last used,     │
│  tombol Disable / Revoke                                    │
└──────────────────────────────────────────────────────────┘
```

Form "Add Token": input label + paste token DO → dienkripsi di server sebelum disimpan, token asli tidak pernah ditampilkan lagi setelah disimpan (hanya label & metadata yang tampil, prinsip write-once seperti API key management pada umumnya).

### 8.7 Jobs (queue monitor)

```
┌──────────────────────────────────────────────────────────┐
│  Jobs             Filter: [pending][processing][failed✓]   │
│                                                              │
│  Type            Account      Status    Attempts  Action    │
│  snapshot        akun-utara   failed    3/3       [Retry]   │
│  create_droplet  akun-timur   pending   0          -        │
│                                                              │
│  Klik row → lihat payload_json & error_log lengkap          │
└──────────────────────────────────────────────────────────┘
```

### 8.8 Audit Log

```
┌──────────────────────────────────────────────────────────┐
│  Audit Log        Filter: [target type ▾]  [tanggal]       │
│                                                              │
│  1 Jul 09:41   system   destroy    server#88   ...          │
│  1 Jul 09:40   system   create     server#91   ...          │
└──────────────────────────────────────────────────────────┘
```

### 8.9 Toast & Notification Center

Dua lapis feedback yang beda fungsi, supaya tidak tumpang tindih dengan Audit Log (Bagian 8.8, catatan permanen) dan Telegram (Bagian 10, alert kondisi kritis):

**1. Toast (popup sekilas)** — muncul setiap kali user melakukan aksi apa pun dari UI (create/resize/destroy server, tambah/nonaktifkan token, retry job, tambah akun, ubah alert rule). Posisi pojok kanan bawah, auto-dismiss, bisa numpuk kalau beberapa aksi cepat berturut-turut.

```
                                          ┌─────────────────────────┐
                                          │ ✓ Job dibuat              │
                                          │ create_droplet (akun-utara)│
                                          │                    [Lihat] │
                                          └─────────────────────────┘
                                          ┌─────────────────────────┐
                                          │ ✕ Gagal menambah token    │
                                          │ Format token tidak valid  │
                                          └─────────────────────────┘
```

| Jenis | Warna | Auto-dismiss | Contoh |
|---|---|---|---|
| Success | Hijau | 4 detik | "Job dibuat", "Token ditambahkan", "Server berhasil di-destroy" |
| Error | Merah | Manual (harus di-close) | "Gagal menambah token: format tidak valid" |
| Info | Biru | 5 detik | "Sinkronisasi saldo dimulai" |

Toast untuk aksi yang menghasilkan job async (create/resize/destroy) selalu punya tombol **[Lihat]** yang lompat ke halaman Jobs — karena toast cuma bilang "job berhasil *dibuat*", bukan "server berhasil *jadi*" (itu baru kelihatan belakangan lewat polling di 8.8/8.5).

**2. Notification Center (ikon 🔔 di topbar)** — dropdown berisi ~15 event terakhir gabungan dari `audit_log` + `alerts_log`, jadi user bisa cek "apa aja yang terjadi barusan" tanpa buka halaman Audit Log penuh. Badge angka = jumlah event belum dibaca (state `read_at` disimpan di localStorage sisi klien, cukup sederhana untuk single-user tool, tidak perlu tabel baru di D1).

```
┌──────────────────────────────────┐
│  Notifikasi              [Tandai │
│                          dibaca] │
├──────────────────────────────────┤
│ ⚠ Server n8n-prod-01 down  2m    │
│ ✓ Job resize selesai       8m    │
│ 💰 Saldo akun-selatan rendah 30m │
│ ✓ Token baru ditambahkan   1j    │
├──────────────────────────────────┤
│         [Lihat semua di Audit Log]│
└──────────────────────────────────┘
```

Sumber data: `GET /api/notifications` (query gabungan `audit_log` + `alerts_log`, sort by waktu, limit 15) — tidak perlu tabel/endpoint terpisah karena datanya sudah ada di dua tabel itu.

### Komponen UI yang dipakai berulang
- **Status badge** (● active hijau, ○ transisi kuning, ⚠ error merah) — konsisten di semua halaman.
- **Progress bar kuota token** — visual langsung, bukan cuma angka, karena ini yang paling sering perlu dicek sekilas.
- **Bulk action bar** — muncul kontekstual saat ada selection, hilang saat kosong.
- **Auto-refresh polling** tiap 5-10 detik untuk halaman Jobs & Server Detail (job/action yang masih in-progress), pakai `setInterval` + fetch ringan, tidak perlu WebSocket untuk skala ini.
- **Toast** — dipicu langsung di frontend setelah tiap response API (2xx → success toast, 4xx/5xx → error toast dengan pesan dari body response).

---

## 9. Alur Kerja Utama

**Create droplet (single/bulk):**
1. User isi form di UI → `POST /api/servers` (atau `/bulk`) → insert `job_queue` (status `pending`) → push ke Cloudflare Queue → return `202` ke UI langsung.
2. Consumer ambil job → panggil `pickCredential()` untuk pilih token dengan kuota terbanyak → call DO API.
3. Kalau sukses: insert `servers`, insert `do_actions` (status `in-progress`), update job jadi `done`.
4. Kalau 429: update job `next_retry_at`, `message.retry({delaySeconds})`.
5. Cron tiap 5 menit cek `do_actions` yang masih `in-progress`, sync status dari DO.

**Token hampir habis:**
- Tiap response DO, header `ratelimit-remaining` disimpan ke `api_credentials.requests_remaining`.
- UI Overview & Tokens page baca kolom ini langsung dari D1 — tidak perlu polling DO API tambahan hanya untuk cek kuota.

---

## 10. Notifikasi & Alerting

Mengirim notifikasi Telegram langsung via **Bot API** (`POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`) — tidak menggunakan Hermes Agent / middleware tambahan. Cukup buat bot via @BotFather, set `TELEGRAM_BOT_TOKEN` sebagai Workers Secret, dan tentukan `TELEGRAM_CHAT_ID` (user/group ID) di Environment Variable.

### Kondisi yang memicu notifikasi (MVP)

| Trigger | Kapan dicek | Contoh pesan |
|---|---|---|
| **Server down** | Cron tiap 5 menit, bandingkan `servers.status` hasil sync terbaru vs sebelumnya | "⚠ n8n-prod-01 (akun-utara) status berubah: active → off" |
| **Token throttled** | Setiap kali `rate_limit_events` dapat insert baru — kalau ≥3 kejadian 429 dalam 10 menit untuk token yang sama | "⚠ Token akun-utara-token1 kena rate limit 3x dalam 10 menit, auto-switch ke token lain" |
| **Job gagal permanen** | Saat `job_queue.attempts` mencapai batas max dan status jadi `failed` | "❌ Job create_droplet (akun-timur) gagal setelah 3x percobaan: [error]" |
| **Saldo rendah** | Setiap sync saldo (cron 30-60 menit), kalau `account_balance_usd` < ambang | "💰 Saldo akun-selatan tinggal $12.40" |

### Skema tambahan

**`alert_rules`** — konfigurasi ambang & channel, biar bisa diubah tanpa redeploy
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| type | TEXT | server_down / token_throttled / job_failed / balance_low |
| enabled | INTEGER | 0/1 |
| threshold_json | TEXT | mis. `{"min_balance": 15}` atau `{"count": 3, "window_minutes": 10}` |
| telegram_chat_id | TEXT | target chat/topic Telegram |

**`alerts_log`** — riwayat notifikasi yang sudah terkirim, untuk audit & mencegah spam (dedup)
| Kolom | Tipe | Ket |
|---|---|---|
| id | INTEGER PK | |
| rule_type | TEXT | |
| target_type / target_id | TEXT | mis. `server` / `88` |
| message | TEXT | |
| sent_at | TEXT | |
| status | TEXT | sent / failed |

Dedup sederhana: sebelum kirim, cek `alerts_log` — kalau sudah ada alert sejenis untuk `target_id` yang sama dalam N menit terakhir, skip (biar server yang down 1 jam nggak spam notif tiap 5 menit, cukup sekali + reminder tiap 1 jam kalau masih down).

### Yang belum termasuk (perlu dibahas terpisah kalau dibutuhkan)
- **Throttling di level droplet** (bandwidth/CPU dibatasi DO) — butuh DO Monitoring API + agent di tiap droplet, beda mekanisme dari yang di atas. Kalau ini yang dimaksud, gue bisa desain terpisah sebagai penambahan di Fase 2/3.
- Kanal selain Telegram (email, dsb) — tidak diperlukan berdasarkan setup yang ada.

---

## 11. Keamanan

- Token DO dienkripsi AES-GCM sebelum disimpan di D1, key disimpan sebagai Workers Secret (`ENCRYPTION_KEY`), tidak pernah muncul di kode/env yang ter-commit.
- Dashboard di belakang Cloudflare Access — tidak ada endpoint yang publicly reachable tanpa login.
- Token asli tidak pernah dikirim balik ke browser setelah disimpan (API hanya return metadata: label, status, quota).
- Semua aksi destruktif (destroy, revoke) butuh konfirmasi dua langkah di UI (modal "ketik nama server untuk konfirmasi").

---

## 12. Non-Functional Requirements

| Aspek | Target |
|---|---|
| Availability | Bergantung Cloudflare edge network (SLA platform) |
| Response time list servers | < 300ms (baca dari D1, bukan live DO API) |
| Job processing latency | < 30 detik dari submit ke eksekusi (di luar retry akibat rate limit) |
| Skala | Dirancang aman untuk puluhan akun DO, ratusan droplet, jauh di bawah batas free tier D1/Workers |
| Observability | Workers Logs + tabel `audit_log` internal sebagai sumber kebenaran |

---

## 13. Fasa Pengembangan

**Fase 1 (MVP)** — Bagian 4 di atas: CRUD droplet, token & akun management, job queue, audit log.

**Fase 2:**
- Throttling di level droplet (bandwidth/CPU) via DO Monitoring API — perlu agent aktif per droplet.
- Estimasi biaya bulanan per akun berdasarkan size_slug aktif (proyeksi, terpisah dari saldo aktual yang sudah ada di MVP).
- Export data ke NocoDB (sinkron read-only, bukan pengganti).

**Fase 3:**
- Dukungan provider lain (skema `providers` sudah disiapkan untuk ini sejak awal).
- Role-based access kalau ada kolaborator tambahan.

---

## 14. Metrik Keberhasilan

- Zero manual login ke DO Console untuk operasi rutin (create/resize/destroy) setelah v1 rilis.
- Tidak ada job gagal permanen akibat rate limit yang seharusnya bisa dihindari dengan rotasi token.
- Waktu dari "butuh 10 droplet baru" ke "10 droplet running" turun signifikan dibanding klik manual satu-satu di Console.

---

## 15. Risiko & Keterbatasan Arsitektur

Bagian ini mendokumentasikan kelemahan yang sudah teridentifikasi di desain saat ini, supaya sadar sejak awal dan bukan ditemukan pas insiden produksi.

### 15.1 Idempotency belum ditangani — risiko droplet dobel ⚠ Kritis
**Masalah:** kalau DO API sukses create droplet tapi Worker gagal/crash sebelum sempat menulis balik ke `servers` (mis. timeout, unhandled exception), job bisa ke-retry dan droplet ke-create dua kali — biaya dobel, data tidak konsisten.

**Mitigasi:** kirim idempotency key ke DO API di setiap request create (DO mendukung ini via parameter/header khusus) — DO sendiri yang menolak duplikat, bukan cuma mengandalkan status `job_queue` di sisi kita. Simpan idempotency key di kolom baru `job_queue.idempotency_key`, generate sekali saat job dibuat (bukan saat retry), dan selalu kirim key yang sama di setiap percobaan.

### 15.2 Race condition saat memilih token ⚠ Kritis
**Masalah:** `pickCredential()` baca `requests_remaining` lalu pilih token dengan sisa terbanyak — tapi kalau beberapa job diproses paralel (Queues bisa scale concurrent consumer), beberapa job bisa memilih token yang sama sebelum salah satu sempat menulis balik kuota terbaru. Efeknya burst request tetap bisa numpuk di satu token walau logic-nya "smart".

**Mitigasi:** pindahkan logic reservasi token ke **Durable Object** (satu DO instance per `credential_id`), yang secara alami serialize akses — job "reserve" kuota lewat DO sebelum call DO API, bukan baca-lalu-pilih dari D1 yang rawan race.

### 15.3 Data kuota & saldo bersifat stale by design
**Masalah:** `requests_remaining` dan `account_balance_usd` cuma ter-update saat ada call/sync — bukan real-time. Kalau nggak ada job jalan selama sejam, angka di UI bisa sudah tidak akurat, terutama kalau token yang sama dipakai proses lain di luar sistem ini.

**Mitigasi:** tampilkan `last synced` di UI secara eksplisit di tiap angka kuota/saldo (bukan cuma di halaman Accounts), supaya jelas ini "kondisi terakhir diketahui" bukan live. Untuk kuota token, tambahkan sync ringan (`GET /v2/account`, tidak menghabiskan kuota berarti) di awal tiap batch job besar, bukan cuma mengandalkan header dari call sebelumnya.

### 15.4 Audit trail belum membedakan aktor
**Masalah:** `audit_log.actor` default `'system'` — kalau ada kolaborator kedua (kemungkinan Fase 3), tidak ada pembeda siapa yang benar-benar memicu aksi.

**Mitigasi:** saat Fase 3 role/permission digarap, jembatani identitas dari Cloudflare Access (header `Cf-Access-Authenticated-User-Email` tersedia otomatis di tiap request) ke kolom `actor` — tidak perlu sistem auth tambahan, tinggal dipetakan.

### 15.5 Single Worker = satu titik gagal operasional
**Masalah:** `fetch()`, `queue()`, dan `scheduled()` ada di Worker yang sama. Bug di queue consumer (mis. unhandled exception berulang) bisa memicu Cloudflare menurunkan performa/throttle Worker itu, yang otomatis ikut mengganggu dashboard walau dashboard sendiri tidak bermasalah.

**Mitigasi:** pastikan setiap path di `queue()` dibungkus try-catch dan tidak pernah throw tanpa ditangani (sudah sebagian ada di `worker.js`, perlu diperluas ke semua job type saat implementasi). Kalau volume job makin besar di masa depan, evaluasi ulang split jadi dua Worker seperti opsi yang sempat dibahas sebelumnya.

### 15.6 Vendor lock-in ke Cloudflare
**Masalah:** D1, Queues, Durable Objects, Workers Secrets semuanya proprietary API. Pindah platform di kemudian hari berarti rewrite storage & job queue, bukan sekadar ganti config.

**Mitigasi:** diterima sebagai trade-off sadar untuk kecepatan development & biaya (semua dalam free tier) — bukan sesuatu yang perlu diselesaikan sekarang, cukup didokumentasikan sebagai keputusan.

### 15.7 Backup & Disaster Recovery Strategy (diimplementasikan)
**Masalah:** PRD belum menyebut mekanisme backup D1 secara eksplisit. Kalau database corrupt/terhapus tidak sengaja, seluruh histori server, job, dan token (yang terenkripsi — tidak bisa direkonstruksi dari DO karena DO tidak menyimpan token yang sudah dibuat) ikut hilang.

**Mitigasi — implementasi lapis ganda:**
1. **D1 Time Travel (built-in)**: point-in-time recovery bawaan D1 aktif, retensi 30 hari. Restore via `wrangler d1 time-travel restore --database-id=... --timestamp=...`.
2. **R2 SQL dump (tambahan)**: Worker cron `0 0 * * *` eksekusi `handleD1Backup()` — query `sqlite_master` untuk dump CREATE TABLE + INSERT statements semua user tables, upload `backup-YYYY-MM-DD.sql` ke R2 bucket `do-manager-backups`. **Retensi 90 hari** — cron hapus objek R2 yang `uploaded > 90 days` via `BACKUP_BUCKET.list()` + `delete()`.
3. **Encryption key terpisah**: `ENCRYPTION_KEY_V1` dan `ENCRYPTION_KEY_V2` **wajib** dibackup terpisah di password manager / vault — D1/R2 backup tanpa key tidak berguna karena semua token DO berupa AES-GCM ciphertext.
4. **Checklist operasional**: uji restore D1 minimal sekali sebelum go-live. Simulasi skenario: (a) restore D1 dari Time Travel, (b) restore dari R2 SQL dump via `wrangler d1 execute`, (c) verifikasi token masih bisa didekripsi setelah restore.

### 15.8 Belum ada strategi testing
**Masalah:** kode ini menangani operasi berbiaya nyata (create/destroy droplet berbayar) tapi PRD belum menyinggung testing sama sekali. Bug kecil di `pickCredential()` atau job consumer bisa langsung berdampak ke biaya atau kehilangan droplet.

**Mitigasi:** minimal sebelum go-live — unit test untuk `pickCredential()` dan idempotency key generation, plus integration test job consumer pakai `wrangler dev` dengan D1 lokal, sebelum menyentuh akun DO sungguhan.

### Open Questions
- **DO API berubah sewaktu-waktu** (rate limit header, response shape) — perlu smoke test tiap kali ada error rate naik tiba-tiba.
- **D1 masih relatif baru** dibanding Postgres — perlu dipantau kalau nanti volume `audit_log`/`rate_limit_events` membengkak, mungkin butuh retention/cleanup job berkala.
- Apakah butuh dukungan Load Balancer/Firewall DO di v1, atau cukup Droplets dulu? (asumsi saat ini: cukup Droplets, sesuai lingkup Bagian 4).
- Siapa saja yang akan jadi user selain Andy — menentukan seberapa penting role/permission di Fase 3, dan seberapa mendesak 15.4 perlu diselesaikan.
