# FITUR.md — Roadmap Parity ZelAI CLI

Tujuan: **semua fitur opencode wajib tersedia di zelaicli**. File ini adalah daftar kerja, bukan dokumentasi jualan. Referensi: `github.com/anomalyco/opencode` branch `dev` dan docs `opencode.ai/docs` (v1, Oktober 2026; v2 sedang berjalan).

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
- [ ] Mode agent `all`
- [ ] Opsi `disable: true`
- [ ] `color` agent di UI
- [ ] Opsi provider arbitrer diteruskan apa adanya (mis. `reasoningEffort`)
- [ ] `permission.task` dengan glob per subagent
- [ ] Agent summary khusus (selain compaction dan title)
- [ ] Invokasi subagent via `@nama` di TUI
- [ ] Navigasi child session subagent (masuk, cycle, kembali ke parent)

### Tools

- [x] `bash` (padanan `shell`), `read`, `write`, `edit`, `grep`, `glob`, `list`
- [x] `apply_patch`, `webfetch`, `websearch`, `question`, `task`, `todowrite`, `skill`
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
- [ ] Kompatibilitas `CLAUDE.md` dan rules agent lain
- [x] Custom slash command `.zelai/command/*.md`
- [ ] Argumen/template command setara opencode

## M2 — TUI parity

- [x] Chat streaming, tool call, tool result, error
- [x] `@file`, `!shell`, `/command`, autocomplete, prompt history
- [x] Picker model, agent, session, theme
- [x] Theme bawaan dan custom
- [x] Keybinds via config
- [x] Footer token/context
- [x] Panel todo dan dialog `question`
- [x] Preview diff setelah edit
- [x] Slash: `/new`, `/sessions`, `/resume`, `/model`, `/agent`, `/plan`, `/build`, `/review`, `/compact`, `/undo`, `/redo`, `/details`, `/theme`, `/keybinds`, `/plugins`, `/lsp`, `/git`, `/status`, `/rename`, `/delete`, `/diff`, `/commit`, `/skills`, `/init`, `/commands`, `/mcp`, `/login`, `/logout`, `/help`, `/quit`
- [ ] `/connect` untuk menambah provider
- [ ] `/editor` compose pesan dengan `$EDITOR`
- [~] `/export` (sekarang hanya lewat CLI `session export`)
- [ ] `/thinking` toggle blok reasoning
- [ ] Command palette `ctrl+p`
- [ ] Image paste/drag di prompt
- [ ] Notifikasi desktop dan suara (`attention`)
- [ ] `diff_style` auto/stacked
- [ ] Config cursor, blinking, mouse, scroll speed/acceleration
- [ ] Leader key dan keymap penuh ala opencode
- [ ] Toggle tampilan username
- [ ] Navigasi session child/tab
- [ ] TUI control API untuk klien eksternal
- [x] `/details`, `/themes`, dan slash command custom

## M3 — Sesi lanjutan

- [x] Session store JSON, atomic write
- [x] Create, list, get, delete, rename, resume, continue, fork
- [x] Export Markdown, import JSON
- [x] Auto title dari pesan pertama
- [x] Token usage per sesi dan `stats`
- [x] Undo/redo berbasis snapshot
- [x] Compaction manual dan otomatis
- [x] `zelai init` menulis `AGENTS.md`
- [ ] Backend SQLite + migrasi (`zelai db`)
- [ ] Status sesi berjalan (endpoint/daftar)
- [ ] Child session untuk subagent
- [ ] Fork pada message tertentu
- [ ] Revert/unrevert per message
- [ ] Diff per message dan per sesi (API + TUI)
- [ ] Ringkasan sesi via agent (selain compaction)
- [ ] `/export` membuka `$EDITOR`
- [ ] Biaya per sesi/model (cost), bukan hanya token
- [ ] Filter `stats` per hari/model/project

## M4 — Ekstensibilitas

### MCP

- [x] Server lokal (stdio)
- [x] Server remote (Streamable HTTP, JSON/SSE)
- [x] `mcp add`, `mcp remove`, `mcp list`
- [ ] OAuth MCP
- [ ] `mcp auth`, `mcp logout`, `mcp debug`
- [ ] Tambah server dinamis via API
- [ ] Status server via API
- [ ] Permission wildcard per tool/server MCP

### Plugin dan custom tool

- [x] Custom tool `.zelai/tools/*.ts`
- [x] Plugin `.zelai/plugins/*.ts`
- [x] Hook `tool.execute.before`, `tool.execute.after`
- [x] Event `session.start`, `session.idle`
- [~] Plugin dari npm spec (belum ada versi/pinning/install)
- [ ] `zelai plugin <module>` untuk install
- [ ] Mode `--pure` (tanpa plugin)
- [ ] Custom tool inline di config

### Skills

- [x] `SKILL.md` global dan project
- [ ] Kompatibilitas `.claude/skills` dan `.agents/skills`
- [ ] Metadata `opencode/slash` (skill sebagai `/command`)
- [ ] Metadata `opencode/autoinvoke`
- [ ] Permission per skill dengan pola wildcard

### References

- [ ] Root alias di config
- [ ] Autocomplete `@alias/`
- [ ] Referensi folder/dokumentasi eksternal

### ACP

- [x] ACP over stdio (NDJSON JSON-RPC)
- [x] `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `set_mode`
- [x] Permission request, tool call update, plan update
- [ ] ACP via TCP (`--port`, `--hostname`, `--cors`)
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
- [ ] `tui.json` terpisah untuk konfigurasi UI
- [ ] Override path config via env (`ZELAI_CONFIG`, `ZELAI_TUI_CONFIG`)
- [ ] API `GET/PATCH /config`
- [ ] Wildcard permission untuk semua tool/custom/MCP
- [ ] `permission.task` glob
- [ ] Policies tingkat organisasi
- [ ] Policy provider/model/tool yang diizinkan
- [ ] Recovery `doom_loop`
- [ ] Validasi config + pesan error terstruktur

## M6 — Provider dan model

- [x] Gateway ZelAI sebagai default
- [x] Device login ZelAI
- [x] Katalog model dan model default
- [x] Model global dan per agent
- [x] `temperature`, `topP`, `steps`
- [ ] Katalog multi-provider (models.dev)
- [ ] Auth per provider: OAuth dan API key
- [ ] `/connect` di TUI
- [ ] Provider lokal (Ollama, LM Studio, dsb.)
- [ ] Provider OpenAI-compatible custom via config
- [ ] Format model `provider/model`
- [ ] Varian model/reasoning effort dan cycle `ctrl+t`
- [ ] Opsi spesifik provider diteruskan
- [ ] Model kecil/cepat untuk title, summary, compaction
- [ ] `zelai models --refresh --verbose`
- [ ] Metadata biaya per model
- [ ] Fallback model saat provider gagal

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
- [ ] Proxy, custom CA, mode offline
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
- [ ] README dan FITUR.md selalu sinkron dengan fitur baru

## Urutan eksekusi

| Batch | Isi | Milestone |
|---|---|---|
| 7 | `/editor`, `/export`, `/thinking`, command palette, image, diff style, mouse/cursor, references, permission wildcard | M2, M5 |
| 8 | Revert/unrevert, fork per message, diff sesi, child session, status, cost, `/export` | M3 |
| 9 | API parity, event bus, TUI control, OpenAPI-generated SDK, contract test | M7 |
| 10 | Multi-provider, OAuth, varian model, model kecil, `/connect` | M6 |
| 11 | MCP OAuth/dynamic, plugin install/`--pure`, skills compat, schema, policies | M4, M5 |
| 12 | Web UI, VS Code/Zed, GitHub/GitLab, PR, desktop | M8 |
| 13 | npm publish, install script, brew/AUR/mise/nix/docker, Windows/WSL, upgrade/uninstall | M9 |
| 14 | Enterprise, ekosistem, hardening, audit parity ulang | M10 |

## Definisi selesai

Sebuah item boleh dicentang jika:

1. Perilaku dan nama fitur dibandingkan langsung dengan opencode.
2. Ada test atau langkah verifikasi yang tercatat.
3. README dan FITUR.md diperbarui.
4. `bun run typecheck` dan `bun run build` lulus.
5. Tidak menghilangkan fitur khas zelaicli di M10.
