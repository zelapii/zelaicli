# FITUR.md — Roadmap Parity ZelAI CLI

Tujuan: **semua fitur opencode wajib tersedia di zelaicli**. File ini adalah daftar kerja, bukan dokumentasi jualan. Referensi utama: `github.com/anomalyco/opencode` branch `dev` dan docs **v2** `opencode.ai/v2/docs` (v1 `opencode.ai/docs` hanya untuk fitur yang belum dimigrasi). Audit terakhir: Oktober 2026.

Status singkat: core agent/tools/TUI/sesi/config sudah terintegrasi; modul `providers`, `pricing`, `policy`, `snapshot`, `diff`, `websearch`, `service`, `pair`, `warming`, `mcp-oauth` sudah ada di `src/`, tetapi sebagian belum diekspos ke CLI/TUI/`serve` dan ditandai `[~]`.

Legenda:

- `[x]` sudah ada dan terverifikasi
- `[~]` parsial / perlu disempurnakan
- `[ ]` belum ada

Aturan:

1. Setiap item opencode harus punya padanan di zelaicli. Kalau opencode menambah fitur baru, tambahkan item baru di file ini.
2. Checkbox `[x]` hanya boleh dicentang setelah ada implementasi, test/verifikasi, dan update README.
3. Fitur khas zelaicli (git tools, `config`, `doctor`, `completion`, gateway ZelAI, server aman) tidak boleh hilang saat mengejar parity.
4. Layanan komersial opencode (Zen/Console/Go) diganti padanan ZelAI (akun, katalog model, usage); fungsi setaranya tetap wajib ada.

## Ringkasan milestone

| Milestone | Fokus | Status | Target |
|---|---|---|---|
| M1 | Agent, tools, rules | Parsial | v0.2 |
| M2 | TUI parity | Parsial | v0.2 |
| M3 | Sesi lanjutan | Parsial | v0.2 |
| M4 | Ekstensibilitas (MCP, plugin, skill, references) | Parsial | v0.3 |
| M5 | Config, permission, policies | Parsial | v0.3 |
| M6 | Provider & model | Belum | v0.4 |
| M7 | Server, API, SDK | Parsial | v0.4 |
| M8 | Integrasi (IDE, web, desktop, GitHub/GitLab) | Belum | v0.5 |
| M9 | Distribusi & platform | Belum | v0.5 |
| M10 | Enterprise & ekosistem | Belum | v1.0 |

## M1 — Agent, tools, rules

### Agent

- [x] Primary `build` (akses penuh)
- [x] Primary `plan` (read-only)
- [x] Primary `review` (read-only, tambahan zelaicli)
- [x] Subagent `general`, `explore`, `scout`
- [x] Custom agent Markdown global dan project
- [x] Opsi agent: `model`, `temperature`, `topP`, `steps`, `permission`, `hidden`, `subagents`, `description`
- [x] `zelai agent create <name>` dan `zelai agent list`
- [x] Ganti agent via picker, `/agent`, `/plan`, `/build`, `/review`
- [x] Auto title dan compaction (setara fungsi hidden agent opencode)
- [ ] Mode agent `primary | subagent | all`
- [ ] Opsi `disable: true` (v2 `disabled`)
- [ ] `color` agent di UI
- [ ] ID agent bersarang (`team/reviewer`) dan tampilan dalam grup
- [x] Opsi provider arbitrer diteruskan apa adanya (mis. `reasoningEffort`)
- [ ] `permission.task` dengan glob per subagent
- [ ] Agent summary khusus (selain compaction dan title)
- [ ] Invokasi subagent via `@nama` di TUI
- [ ] Navigasi child session subagent (masuk, cycle, kembali ke parent)

### Tools

- [x] `bash` (padanan `shell`), `read`, `write`, `edit`, `grep`, `glob`, `list`
- [x] `apply_patch` (padanan `patch`), `webfetch`, `websearch`, `question`, `task` (padanan `subagent`), `todowrite`, `skill`
- [ ] Nama/parameter tool v2 persis: `shell`, `patch`, `subagent` (termasuk alias lama tetap jalan)
- [ ] `read` gambar (PNG/JPEG/GIF/WebP) dan PDF maks 20MiB
- [ ] Batas `grep`/`glob` v2 (100 hasil, timeout 30s) dan penomoran baris `read`
- [ ] Tool `execute`/codemode dan `browser`
- [x] Tool tambahan: `git_status`, `git_diff`, `git_log`, `git_commit`
- [x] LSP: diagnostics, definition, references, hover
- [ ] LSP: `documentSymbol`, `workspaceSymbol`, `goToImplementation`, call hierarchy
- [ ] Auto-download language server seperti opencode
- [x] Formatter otomatis setelah edit
- [x] Attachment file teks via `-f/--file`
- [ ] Attachment gambar (paste/drag)
- [x] Referensi file `@` dengan fuzzy search dan completion
- [ ] References alias root (`@alias/...`) via config
- [~] `grep`/`glob` berbasis ripgrep (sekarang implementasi internal)
- [x] Menghormati `.gitignore` dan `.ignore`
- [ ] Allowlist path di `.ignore` seperti opencode
- [x] Permission `external_directory`
- [ ] Deteksi/`doom_loop` recovery saat agent macet

### Rules dan command

- [x] `AGENTS.md` global dan project
- [x] `instructions` tambahan via config
- [x] `AGENTS.md` saja (v2 tidak lagi fallback `CLAUDE.md`; item lama dibatalkan)
- [x] Custom slash command `.zelai/command/*.md`
- [ ] Argumen/template command setara opencode: `$ARGUMENTS`, `$1`/`$2`, shell block, path bersarang, `template` di JSON config, frontmatter `agent`/`model`
- [ ] Instructions dimuat dari global + workspace naik ke root, plus penemuan dinamis saat membaca file

## M2 — TUI parity

- [x] Chat streaming, tool call, tool result, error
- [x] `@file`, `!shell`, `/command`, autocomplete, prompt history
- [x] Picker model, agent, session, theme
- [x] Theme bawaan dan custom
- [x] Keybinds via config
- [x] Footer token/context
- [x] Panel todo dan dialog `question`
- [x] Preview diff setelah edit
- [x] Slash: `/new`, `/sessions`, `/resume`, `/model`, `/agent`, `/plan`, `/build`, `/review`, `/compact`, `/undo`, `/redo`, `/revert`, `/unrevert`, `/fork`, `/details`, `/theme`, `/keybinds`, `/plugins`, `/lsp`, `/git`, `/status`, `/rename`, `/delete`, `/diff`, `/commit`, `/skills`, `/init`, `/commands`, `/mcp`, `/login`, `/logout`, `/help`, `/quit`
- [ ] `/connect` untuk menambah provider
- [x] `/editor` menyusun pesan dengan `$EDITOR`/`$VISUAL` (suspend/resume renderer)
- [x] `/export` menulis Markdown sesi ke `~/.local/share/zelai/exports/`
- [~] `/thinking` toggle blok reasoning (implementasi ada, belum diuji dengan model reasoning)
- [~] Command palette `ctrl+p` (implementasi ada, perlu uji TUI)
- [ ] Image paste/drag di prompt
- [ ] Notifikasi desktop dan suara (`attention`)
- [ ] `diff_style` auto/stacked (config `tui.diffStyle` sudah ada, render belum)
- [x] Config `tui.mouse` dan `tui.cursor` (`style`, `blinking`)
- [ ] Config scroll speed/acceleration
- [ ] Leader key (default `ctrl+x`) dan keymap penuh v2 (`app.exit`, `command.palette.show`, `<leader>`)
- [ ] Toggle tampilan username
- [ ] Tab sesi dan shell mode `!`
- [x] Referensi `@file#20-45` (rentang baris)
- [ ] `/btw` pertanyaan sampingan dan `/highlights`
- [ ] Mode mini dan settings dialog
- [ ] Navigasi session child/tab
- [ ] TUI control API untuk klien eksternal
- [~] Config UI terpisah `cli.json` (global) + `ZELAI_CLI_CONFIG_CONTENT` (loader + merge sudah ada, reload live belum)
- [x] `/details`, `/themes`, dan slash command custom

## M3 — Sesi lanjutan

- [x] Session store JSON, atomic write
- [x] Create, list, get, delete, rename, resume, continue, fork
- [x] Export Markdown, import JSON
- [x] Auto title dari pesan pertama
- [x] Token usage per sesi dan `stats`
- [x] Undo/redo berbasis snapshot
- [~] Snapshot v2: `/undo` rollback file + percakapan per turn dan mengembalikan prompt; `/redo` membatalkan undo. Snapshot worktree (`snapshot.ts`) sudah ada; belum: batas untracked ≤2MiB teruji penuh
- [x] Compaction manual dan otomatis
- [ ] Compaction v2: `compaction.auto`, `keep.tokens` (default 15000), pemicu manual via API, event `session.compaction.*`
- [ ] Attachment v2: `{uri,name,description}` dengan `file:`/`data:` URL, rentang baris, 20MiB
- [x] `zelai init` menulis `AGENTS.md`
- [ ] Backend SQLite + migrasi (`zelai db`)
- [~] Status sesi berjalan: `GET /sessions/status`; belum ada perintah CLI/TUI
- [x] Child session untuk subagent
- [~] Fork pada message tertentu: `session fork --at <n>` dan `POST /sessions/:id/fork`; TUI masih fork seluruh percakapan
- [~] Revert/unrevert: `/revert [n]`, `/unrevert`, `session revert/unrevert`, endpoint server; per-turn, belum per pesan tunggal
- [ ] Diff per message dan per sesi (API + TUI); `diff.ts`/`snapshot.ts` sudah menyediakan unified diff
- [ ] Ringkasan sesi via agent (selain compaction)
- [x] `/export` membuka `$EDITOR`
- [x] Biaya per sesi/model (cost), bukan hanya token
- [ ] Filter `stats` per hari/model/project

## M4 — Ekstensibilitas

### MCP

- [x] Server lokal (stdio)
- [x] Server remote (Streamable HTTP, JSON/SSE)
- [x] `mcp add`, `mcp remove`, `mcp list`
- [ ] Schema v2 `mcp.servers` (nested) dan `mcp add --url/--global`
- [~] OAuth MCP + perintah `/mcps` (modul `mcp-oauth.ts` siap, belum terhubung ke `mcp.ts`/CLI)
- [ ] `mcp auth`, `mcp logout`, `mcp debug`
- [ ] Tambah server dinamis via API
- [ ] Status server via API
- [ ] Resources/prompts/instructions MCP (bukan hanya tools)
- [x] Permission wildcard per tool/server MCP

### Plugin dan custom tool

- [x] Custom tool `.zelai/tools/*.ts`
- [x] Plugin `.zelai/plugins/*.ts`
- [x] Hook `tool.execute.before`, `tool.execute.after`
- [x] Event `session.start`, `session.idle`
- [~] Plugin dari npm spec (belum ada versi/pinning/install)
- [ ] API plugin v2 `Plugin.define({ id, setup(ctx) })`, cleanup, transform, RPC
- [ ] Plugin CLI/TUI (`@opencode/plugin/tui`): command, route, slot, markdown renderer, notifikasi/toast
- [ ] Enable/disable plugin dengan wildcard (`-id`, `*`, `.*`) dan proteksi plugin builtin
- [ ] `zelai plugin <module>` untuk install
- [ ] Mode `--pure` (tanpa plugin)
- [ ] Custom tool inline di config

### Skills

- [x] `SKILL.md` global dan project
- [ ] Kompatibilitas `~/.claude/skills`, `~/.agents/skills`, `.claude/skills`, `.agents/skills`
- [ ] `SKILL.md` di root direktori skill dan grup bersarang
- [ ] Path relatif terhadap `SKILL.md`, metadata `opencode/slash`, `opencode/autoinvoke`
- [ ] Permission per skill dengan pola wildcard

### References

- [x] Root alias di config (`references` map)
- [x] Autocomplete `@alias/` dan daftar file alias
- [ ] Referensi folder/dokumentasi eksternal
- [ ] Referensi repository + branch (git remote, shorthand GitHub, SSH/SCP)
- [ ] String shorthand v2 (`.`/`/`/`~` lokal, bare = git) dan `path`/`repository`

### ACP

- [x] ACP over stdio (NDJSON JSON-RPC)
- [x] `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `set_mode`
- [x] Permission request, tool call update, plan update
- [ ] ACP via TCP (`--port`, `--hostname`, `--cors`)
- [ ] ACP v2: auth method `opencode-login`, terminal-auth (`--login`), `auth_required`
- [ ] Packaging ekstensi Zed/IDE berbasis ACP

## M5 — Config, permission, policies

- [x] Config global + project, JSONC
- [x] `zelai config get/set/unset`
- [x] Masking secret
- [x] Config server (host, port, password, CORS)
- [x] Config theme, keybind, LSP, MCP, plugins, formatter, instructions, permission
- [x] Permission per agent
- [x] Permission `edit`, `bash` (pola), `task`, `mcp`, `read`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `skill`, `external_directory`, `question`, `lsp`, `git`
- [ ] JSON Schema `$schema` dan autocomplete editor
- [~] `cli.json` terpisah untuk konfigurasi UI (loader + merge sudah ada, reload live belum)
- [~] Override path config via env (`ZELAI_CONFIG`, `ZELAI_CLI_CONFIG`, `ZELAI_CLI_CONFIG_CONTENT`); baru `cli.json` yang punya env override
- [ ] API `GET/PATCH /config`
- [x] Wildcard permission untuk semua tool/custom/MCP
- [x] Schema permission v2 berbasis list `[{action, resource, effect}]`, last-match-wins, aksi `shell`/`subagent`/`edit`/`read`/`glob`/`grep`/`websearch` (dikonversi ke permission map)
- [ ] `permission.task` glob
- [~] Policies tingkat organisasi (policy lokal provider/tool/integration sudah ada; belum tersinkron Console)
- [x] Policy binary tanpa prompt: `provider.use`, `tool.use`, `integration.use`
- [ ] Recovery `doom_loop`
- [ ] Validasi config + pesan error terstruktur

## M6 — Provider dan model

- [x] Gateway ZelAI sebagai default
- [x] Device login ZelAI
- [x] Katalog model dan model default
- [x] Model global dan per agent
- [x] `temperature`, `topP`, `steps`
- [~] Katalog multi-provider (config `providers`, discovery lokal; belum models.dev)
- [~] Auth per provider: API key via config/env; OAuth provider belum
- [ ] `/connect` di TUI
- [~] Provider lokal (Ollama, LM Studio): discovery ada, belum terhubung ke picker
- [x] Provider OpenAI-compatible custom via config
- [x] Format model `provider/model`
- [~] Varian model/reasoning effort (`provider/model#high` sudah; cycle `ctrl+t` belum)
- [x] Opsi spesifik provider diteruskan
- [ ] Model kecil/cepat untuk title, summary, compaction
- [ ] `zelai models --refresh --verbose`
- [x] Metadata biaya per model (`pricing.ts`, cost sesi)
- [ ] Fallback model saat provider gagal
- [x] Varian model `provider/model#high` (reasoning effort); cycle `ctrl+t` belum
- [~] Config `providers`: `env`, `baseUrl`, `headers`, `options`, `models`; `package`/`canonical`/`compatibility` belum
- [~] Discovery provider lokal (Ollama, LM Studio, dsb.) dan `ZELAI_DISABLE_FREE_MODELS`/`OPENCODE_DISABLE_FREE_MODELS` (fungsi ada, belum dipanggil CLI)
- [~] Warming keep-alive request (`provider.warming`: prompt, interval 4m, duration 30m, default mati) — `warming.ts` ada, belum dijalankan `serve`
- [x] Websearch multi-provider: `exa`, `firecrawl`, `parallel`, `tavily`, `tinyfish`, `random` + failover 429

## M7 — Server, API, SDK

- [x] `zelai serve` host/port
- [x] Auth Basic/Bearer, password via flag/env/config
- [x] Menolak bind non-loopback tanpa password
- [x] CORS allowlist dan `*`
- [x] `GET /health`, `/app`, `/doc`, `/models`
- [x] Sessions: list, create, get, delete, messages
- [x] Prompt SSE, cancel, permission
- [x] SDK TypeScript manual (`@zelapii/cli/sdk`)
- [ ] SDK generated dari OpenAPI (tipe lengkap)
- [ ] Event global SSE + event per sesi
- [ ] Background service v2: `zelai service status/start/stop/restart` dan `service set/get/unset env|cors|disabled` (`service.ts` sudah ada, CLI belum)
- [ ] `zelai api get/post` untuk memanggil API lokal
- [ ] `--standalone`/`--server` dan pemisahan state client-server
- [ ] SDK embedded in-process (setara `@opencode/sdk`, in-memory router, `await using`)
- [ ] Paket client HTTP (setara `@opencode/client`): koneksi lazy, event async iterable, worktree
- [ ] `/project`, `/path`, `/vcs`, `/instance`
- [ ] `/config` GET/PATCH
- [ ] `/provider`, `/provider/auth`, OAuth authorize/callback
- [ ] Session status, children, init, fork per message, abort, diff, summarize, revert, unrevert
- [ ] Message GET/POST, `prompt_async`, command, shell
- [ ] `/find`, `/find/file`, `/find/symbol`
- [ ] `/file`, `/file/content`, `/file/status`
- [ ] `/lsp`, `/formatter`, `/mcp` GET/POST, `/agent`, `/log`
- [ ] TUI control: append/submit/clear prompt, open help/sessions/themes/models, toast, control
- [ ] `/auth/:id`
- [ ] mDNS discovery
- [ ] Username Basic auth dapat dikonfigurasi
- [ ] Remote TUI penuh (bukan hanya `attach` satu prompt)
- [ ] Web UI
- [ ] Contract test API
- [ ] `--print-logs`, `--log-level`

## M8 — Integrasi

- [x] ACP untuk Zed/klien ACP
- [ ] Ekstensi VS Code
- [ ] Ekstensi Zed resmi/packaging
- [ ] Desktop app (macOS, Windows, Linux)
- [~] `zelai pair`: web UI loopback (port 49374/28894), password, sesi 30 hari, QR (`pair.ts` ada, CLI belum)
- [ ] `zelai pair --remote` (OpenTunnel) dan mode `zelai mini`
- [ ] Web UI
- [ ] GitHub agent/action
- [ ] GitLab
- [ ] Checkout PR (`zelai pr`)
- [ ] Dashboard akun ZelAI (setara Console)
- [ ] Usage/billing ZelAI (setara Console/Go)
- [ ] Direktori ekosistem/plugin
- [ ] Windows native
- [ ] Dukungan WSL + dokumentasi
- [ ] Enterprise: SSO, audit log, kebijakan terpusat

## M9 — Distribusi dan operasional

- [x] Build binary tunggal
- [x] Shell completion bash/zsh/fish
- [x] `zelai config`, `zelai doctor`
- [x] `zelai upgrade` (petunjuk)
- [~] Paket npm siap, belum dipublikasikan
- [ ] Publikasi `@zelapii/cli`
- [ ] Install script `curl ... | bash`
- [ ] Homebrew
- [ ] Pacman/AUR
- [ ] mise
- [ ] Nix flake
- [ ] Docker image
- [ ] `zelai upgrade` self-update
- [ ] `zelai uninstall`
- [ ] Pemeriksaan update otomatis
- [ ] `zelai db` (migrasi/inspeksi)
- [ ] Proxy `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (loopback wajib), custom CA, mode offline, persist via `service set env`
- [ ] Migrasi v1 → v2: plugins API, server API/client, `tui.json` → `cli.json`
- [ ] CI macOS/Windows/Linux + artifact rilis
- [ ] Checksum dan signing
- [ ] CHANGELOG dan release notes

## M10 — Fitur khas zelaicli yang wajib dipertahankan

- [x] Tool git native dan slash `/git`, `/diff`, `/commit`
- [x] `zelai config` dan `zelai doctor`
- [x] `zelai session rename`
- [x] Fallback `tsserver` saat `typescript-language-server` tidak ada
- [x] Server default aman (loopback, tolak bind publik tanpa password)
- [x] Login gateway ZelAI (device flow)
- [x] Binary tunggal tanpa Node
- [x] README dan FITUR.md selalu sinkron dengan fitur baru

## Urutan eksekusi

| Batch | Isi | Milestone |
|---|---|---|
| 7 | `/editor`, `/export`, `/thinking`, command palette, references, permission wildcard, `tui.mouse` (**selesai, menunggu uji TUI**) | M2, M4, M5 |
| 8 | Snapshot v2 (`/undo` file + prompt, `/redo`), revert/unrevert, fork per message, diff sesi, child session, status, cost — **selesai: undo turn, revert/unrevert, fork `--at`, status endpoint, child session, cost; diff sesi belum** | M3 |
| 9 | API parity, background service + `zelai api`, `--standalone`, event bus, TUI control, OpenAPI SDK, SDK embedded + client HTTP, contract test | M7 |
| 10 | Multi-provider, OAuth, varian `#high`, provider lokal, `providers` config, warming, websearch multi-provider, model kecil, `/connect` — **selesai: routing `provider/model`, varian `#high`, config provider, pricing, websearch failover; OAuth/warming/`/connect` belum** | M6 |
| 11 | MCP v2/OAuth, plugin v2 + plugin TUI, skills compat, schema config/permission list, policies — **selesai: permission list, policies lokal; MCP OAuth/plugin v2 belum** | M4, M5 |
| 12 | TUI v2: `cli.json`, leader/tab/shell mode/`@file#line`/`/btw`/`/highlights`/mini/settings, diff style, cursor, image, attention | M2 |
| 13 | `zelai pair` + web UI, desktop, mini web, VS Code/Zed, GitHub/GitLab, PR | M8 |
| 14 | npm publish, install script, brew/AUR/mise/nix/docker, Windows/WSL, upgrade/uninstall, migrasi v1→v2 | M9 |
| 15 | Enterprise/Console parity, ekosistem, hardening, audit parity ulang | M8, M10 |

## Definisi selesai

Sebuah item boleh dicentang jika:

1. Perilaku dan nama fitur dibandingkan langsung dengan opencode.
2. Ada test atau langkah verifikasi yang tercatat.
3. README dan FITUR.md diperbarui.
4. `bun run typecheck` dan `bun run build` lulus.
5. Tidak menghilangkan fitur khas zelaicli di M10.
