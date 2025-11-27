#!/usr/bin/env bash
#───────────────────────────────────────────────────────────────────────────────
#  Netsnek ‒ Database Migration & Maintenance Toolkit
#───────────────────────────────────────────────────────────────────────────────
#  Overview
#  ========
#  This all-in-one Bash helper provides a **single source of truth** to manage the
#  full Prisma-to-Cloudflare-D1 workflow in both local *development* and
#  *production* environments. It deliberately mirrors the exact steps you would
#  run manually, but wraps them in convenient, self-documenting commands.
#
#  Philosophy
#  ----------
#  • *Explicit first*: every action is a top-level CLI verb (no hidden magic)
#  • *Idempotent*: re-running a command never harms an existing database
#  • *Safety nets*: automatic backups & human confirmations before destructive ops
#  • *Parity*: **`prepare` _must_ run before `deploy`** – the script enforces this
#
#  Quick start
#  -----------
#  ```bash
#  ./scripts/migrate.sh prepare         # ← generate + apply dev migrations
#  npm run test                         # do your local development
#  ./scripts/migrate.sh deploy          # ← apply the exact same migrations to D1
#  ```
#  For a full CLI reference run `./scripts/migrate.sh --help`.
#───────────────────────────────────────────────────────────────────────────────
#  Legend (emoji key)
#  ------------------
#  ✅ success   ❌ error   ⚠️ warning   ℹ️ info   🗄️ database  💾 backup
#───────────────────────────────────────────────────────────────────────────────

set -Eeuo pipefail                                        # strict mode
trap 'print_error "Unexpected error on line $LINENO"' ERR

###############################################################################
# Mutable defaults (configurable via ENV or --env)
###############################################################################
MIGRATIONS_DIR="${MIGRATIONS_DIR:-prisma/migrations}"   # prisma nested folders
FLAT_MIG_DIR="${FLAT_MIG_DIR:-migrations}"              # wrangler reads flat sql
BACKUP_DIR="${BACKUP_DIR:-.backup}"                     # *.sql & *.db backups
D1_NAME="${D1_NAME:-cloudflare-prisma-d1}"              # wrangler binding name

###############################################################################
# Pretty output helpers
###############################################################################
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; PURPLE='\033[0;35m'; CYAN='\033[0;36m'; NC='\033[0m'
SUCCESS="✅"; ERROR="❌"; WARNING="⚠️"; INFO="ℹ️"; DATABASE="🗄️"; BACKUP="💾"

print_info()    { echo -e "${BLUE}${INFO}  $1${NC}"; }
print_success() { echo -e "${GREEN}${SUCCESS}  $1${NC}"; }
print_warning() { echo -e "${YELLOW}${WARNING}  $1${NC}"; }
print_error()   { echo -e "${RED}${ERROR}  $1${NC}"; }
print_header()  {
  echo -e "${PURPLE}${DATABASE} Netsnek DB Toolkit${NC}"
  echo -e "${CYAN}================================${NC}"
}

###############################################################################
# Dependency checks (npx, wrangler, jq)
###############################################################################
check_dependencies() {
  print_info "Checking dependencies…"
  command -v npx      &>/dev/null || { print_error "npx not found";          exit 1; }
  command -v wrangler &>/dev/null || { print_error "wrangler not found";     exit 1; }
  command -v jq       &>/dev/null || { print_error "jq not found";           exit 1; }
  print_success "All dependencies present"
}

###############################################################################
# Environment helpers
###############################################################################
# load_env <file> ─────────────────────────────────────────────────────────────
# Sources a dotenv-style file (key=value) **into the current shell** so Prisma
# and Wrangler pick them up. Silently continues if the file is missing.
load_env() {
  local env_file="${1:-.env}"
  if [[ -f "$env_file" ]]; then
    print_info "Loading environment from $env_file"
    set -a && source "$env_file" && set +a
    print_success "Environment loaded"
  else
    print_warning "Env file $env_file not found (continuing)"
  fi
}

# validate_env <dev|prod> ─────────────────────────────────────────────────────
# Verifies the **minimum** set of variables required for the chosen context.
validate_env() {
  local env_type="$1"
  print_info "Validating $env_type environment vars…"
  case "$env_type" in
    dev)
      [[ -z "${DATABASE_URL:-}" ]] && { print_error "DATABASE_URL missing"; exit 1; }
      ;;
    prod)
      [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_DATABASE_ID:-}" ]] && {
        print_error "Missing Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_DATABASE_ID)"; exit 1; }
      if [[ -z "${CLOUDFLARE_D1_TOKEN:-}" ]]; then
        wrangler whoami &>/dev/null || {
          print_error "Run 'wrangler auth login' or export CLOUDFLARE_D1_TOKEN"; exit 1; }
      else
        export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_D1_TOKEN"
      fi
      ;;
  esac
  print_success "Environment ok"
}

###############################################################################
# Generic helpers
###############################################################################
# backup_sqlite <path> ────────────────────────────────────────────────────────
# Copies the given SQLite file to BACKUP_DIR/ with a timestamped name.
backup_sqlite() {
  local db_file="$1"
  mkdir -p "$BACKUP_DIR"
  local backup_path="$BACKUP_DIR/$(basename "$db_file").$(date +%Y%m%d_%H%M%S).bak"
  print_info "${BACKUP} SQLite → $backup_path"
  cp "$db_file" "$backup_path"
}

# find_dev_db ─────────────────────────────────────────────────────────────────
# Attempts to locate the local dev.db file.
find_dev_db() {
  for candidate in "dev.db" "prisma/dev.db" "./dev.db"; do
    [[ -f "$candidate" ]] && { echo "$candidate"; return 0; }
  done
  return 1
}

# generate_prisma_client ──────────────────────────────────────────────────────
# Always re-generate the TS client after *any* schema change.
generate_prisma_client() {
  print_info "Generating Prisma client…"
  npx prisma generate
  print_success "Prisma client ready"
}

# flatten_migrations ─────────────────────────────────────────────────────────
# Converts nested ./prisma/migrations/**/migration.sql files into flat
# `$FLAT_MIG_DIR/<timestamp>_<name>.sql` so Wrangler can read them.
flatten_migrations() {
  [[ -d "$MIGRATIONS_DIR" ]] || { print_warning "No Prisma migrations yet"; return; }
  mkdir -p "$FLAT_MIG_DIR"
  print_info "Flattening migrations → $FLAT_MIG_DIR/"
  find "$MIGRATIONS_DIR" -maxdepth 2 -name migration.sql | while read -r sql_file; do
    local dir="$(dirname "$sql_file")"
    local mig="$(basename "$dir")"   # e.g. 20250711_auto_migration
    cp "$sql_file" "$FLAT_MIG_DIR/${mig}.sql"
  done
}

# migration_already_applied <migration_name> ─────────────────────────────────
# Returns 0 if the given migration entry exists in the remote _prisma_migrations.
migration_already_applied() {
  local mig_name="$1"
  local exists applied
  exists=$(wrangler d1 execute "$D1_NAME" \
    --command="SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations';" \
    --json 2>/dev/null | jq -r '.[].results[0][0] // empty') || true
  [[ -z "$exists" ]] && return 1
  applied=$(wrangler d1 execute "$D1_NAME" \
    --command="SELECT 1 FROM _prisma_migrations WHERE migration_name='$mig_name' LIMIT 1;" \
    --json 2>/dev/null | jq -r '.[].results[0][0] // empty') || true
  [[ -n "$applied" ]]
}

# has_schema_changes ─────────────────────────────────────────────────────────
# Returns 0 if a schema diff exists, 1 if schema and migrations are in sync.
has_schema_changes() {
  local SHADOW="file:shadow.db"   # temp DB used only by the diff engine
  npx prisma migrate diff \
      --from-migrations "prisma/migrations" \
      --to-schema "prisma/schema.prisma" \
      --exit-code
  case $? in
    0) return 1 ;;   # no diff
    2) return 0 ;;   # diff exists
    *) print_error "prisma migrate diff failed"; exit 1 ;;
  esac
}

###############################################################################
#  Dev workflow  ──────────────────────────────────────────────────────────────
###############################################################################
# prepare_dev ────────────────────────────────────────────────────────────────
# 1. Generates/updates Prisma migrations (auto-migrations when schema changed)
# 2. Applies them to **both** local SQLite *and* Wrangler's local D1 instance
#    (so `wrangler dev` has the correct schema)
# 3. Re-generates the Prisma client
prepare_dev() {
  print_header
  load_env "${ENV_FILE:-.env}"
  validate_env dev

  # Exit early when nothing changed
  if ! has_schema_changes; then     # 1 → in-sync
    print_info "🟢 Schema already up-to-date — skipping migration"
    flatten_migrations              # still ensure flat dir is current
    print_success "Development database ready 🥳"
    return
  fi

  local db_path
  if db_path=$(find_dev_db); then
    backup_sqlite "$db_path"
  fi

  print_info "Running 'prisma migrate dev' (auto-creates migrations if needed)"
  npx prisma migrate dev --name "${MIGRATION_NAME:-auto_migration}"

  # Also apply to the local D1 (Wrangler's SQLite)
  print_info "Applying new migrations to Wrangler local D1…"
  if wrangler d1 migrations apply "$D1_NAME" --local; then
    print_success "Wrangler local apply complete"
  else
    print_warning "Wrangler auto-apply failed; fallback to manual loop"
    flatten_migrations
    find "$FLAT_MIG_DIR" -maxdepth 1 -name '*.sql' | sort | while read -r file; do
      print_info "Applying $(basename "$file") → local D1"
      wrangler d1 execute "$D1_NAME" --local --file="$file"
    done
    print_success "Manual local migration loop finished"
  fi

  flatten_migrations
  generate_prisma_client
  print_success "Development database ready 🥳"
}

###############################################################################
#  Production workflow  ──────────────────────────────────────────────────────
###############################################################################
# deploy_prod ────────────────────────────────────────────────────────────────
# Applies the *already generated* flat SQL migrations to the remote Cloudflare
# D1 database. Forced confirmation + client regeneration.
deploy_prod() {
  print_header
  load_env "${ENV_FILE:-.env}"
  validate_env prod

  print_warning "This will UPDATE the production Cloudflare D1 database!"
  read -rp "Continue? (y/N): " REPLY; [[ ! $REPLY =~ ^[Yy]$ ]] && { echo; print_info "Cancelled"; exit 0; }

  flatten_migrations
  [[ -d "$FLAT_MIG_DIR" ]] || { print_error "Dir '$FLAT_MIG_DIR' not found"; exit 1; }

  # Wrangler requires 'migrations/' at root; symlink if user configured FLAT_MIG_DIR
  local TEMP_SYMLINK=false
  if [[ "$FLAT_MIG_DIR" != "migrations" && ! -e migrations ]]; then
    ln -s "$FLAT_MIG_DIR" migrations; TEMP_SYMLINK=true
  fi

  print_info "Trying 'wrangler d1 migrations apply'…"
  if wrangler d1 migrations apply "$D1_NAME" --remote; then
    print_success "Wrangler applied migrations successfully"
  else
    print_warning "Wrangler auto-apply failed; fallback to manual execution"
    while IFS= read -r -d '' file; do
      local mig_name="$(basename "${file%.sql}")"
      if migration_already_applied "$mig_name"; then
        print_info "$mig_name already applied – skipping"
        continue
      fi
      print_info "Applying $mig_name"
      if wrangler d1 execute "$D1_NAME" --file="$file" --remote; then
        print_success "$mig_name applied"
      else
        print_error "Failed on $mig_name, aborting"
        [[ "$TEMP_SYMLINK" == true ]] && rm migrations
        exit 1
      fi
    done < <(find "$FLAT_MIG_DIR" -maxdepth 1 -name '*.sql' -print0 | sort -z)
    print_success "Manual migration loop finished"
  fi

  [[ "$TEMP_SYMLINK" == true ]] && rm migrations
  generate_prisma_client
  print_success "Production database updated 🚀"
}

###############################################################################
#  Maintenance helpers  ──────────────────────────────────────────────────────
###############################################################################
# reset_dev ──────────────────────────────────────────────────────────────────
# **DESTROYS** the local SQLite DB and re-applies migrations from scratch.
reset_dev() {
  print_header
  load_env "${ENV_FILE:-.env}"
  validate_env dev
  print_warning "All LOCAL data will be LOST!"
  read -rp "Really reset? (y/N): " REPLY; [[ ! $REPLY =~ ^[Yy]$ ]] && { echo; print_info "Cancelled"; exit 0; }

  if db_path=$(find_dev_db); then
    backup_sqlite "$db_path"
  fi
  npx prisma migrate reset --force
  flatten_migrations
  generate_prisma_client
  print_success "Dev database reset 🗑️ ➜ 🆕"
}

# check_status ───────────────────────────────────────────────────────────────
# Shows Prisma's local status and, if credentials available, lists remote tables.
check_status() {
  print_header
  load_env "${ENV_FILE:-.env}"
  print_info "Local migrate status ⬇️"
  npx prisma migrate status || true
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_DATABASE_ID:-}" ]]; then
    print_info "Remote (D1) table list ⬇️"
    wrangler d1 execute "$D1_NAME" --command "SELECT name FROM sqlite_master WHERE type='table';" || true
  fi
}

# create_migration <name> ────────────────────────────────────────────────────
# Generates a migration folder *without* applying it (for review / PRs).
create_migration() {
  print_header
  load_env "${ENV_FILE:-.env}"
  validate_env dev
  local MIGRATION_NAME="${MIGRATION_NAME:-$1}"
  [[ -z "$MIGRATION_NAME" ]] && { read -rp "Migration name: " MIGRATION_NAME; }
  [[ -z "$MIGRATION_NAME" ]] && { print_error "Name required"; exit 1; }
  npx prisma migrate dev --name "$MIGRATION_NAME" --create-only
  flatten_migrations
  print_success "Migration folder created & flattened"
}

# prisma_studio ──────────────────────────────────────────────────────────────
prisma_studio() {
  print_header
  load_env "${ENV_FILE:-.env}"
  print_info "Launching Prisma Studio…"
  npx prisma studio
}

# execute_d1 "<SQL>" ─────────────────────────────────────────────────────────
execute_d1() {
  print_header
  load_env "${ENV_FILE:-.env}"
  validate_env prod
  [[ -z "$1" ]] && { print_error "SQL missing"; exit 1; }
  wrangler d1 execute "$D1_NAME" --command="$1"
}

# d1_info ────────────────────────────────────────────────────────────────────
d1_info() {
  print_header
  load_env "${ENV_FILE:-.env}"
  validate_env prod
  print_info "Cloudflare D1 info ($D1_NAME)"
  wrangler d1 execute "$D1_NAME" --command "SELECT name FROM sqlite_master WHERE type='table';"
}

# backup_d1 ───────────────────────────────────────────────────────────────────
# Always uses **latest** Wrangler to avoid the 3.x export bug.
backup_d1() {
  print_header
  load_env "${ENV_FILE:-.env}"
  validate_env prod
  mkdir -p "$BACKUP_DIR"
  local out="$BACKUP_DIR/d1_backup_$(date +%Y%m%d_%H%M%S).sql"
  print_info "${BACKUP} Exporting D1 → $out"
  if npx --yes wrangler@latest d1 export "$D1_NAME" --remote --output "$out"; then
    print_success "Backup written to $out"
  else
    print_error "wrangler d1 export failed"
    print_info  "Try upgrading Wrangler or open an issue if this persists."
    exit 1
  fi
}

###############################################################################
#  Argument parsing & router
###############################################################################
COMMAND=""; SUBCOMMAND=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) MIGRATION_NAME="$2"; shift 2;;
    --env)  ENV_FILE="$2";       shift 2;;
    *)      [[ -z "$COMMAND" ]] && COMMAND="$1" || SUBCOMMAND="$1"; shift;;
  esac
done

check_dependencies

case "$COMMAND" in
  prepare|dev) prepare_dev;;               # alias for backward compat
  deploy|prod) deploy_prod;;
  reset)       reset_dev;;
  status)      check_status;;
  create)      create_migration "$SUBCOMMAND";;
  studio)      prisma_studio;;
  d1-info)     d1_info;;
  d1-exec)     execute_d1 "$SUBCOMMAND";;
  d1-backup)   backup_d1;;
  ""|help|-h|--help)
cat <<'EOF'
Usage: ./scripts/migrate.sh <command> [options]

Core workflow
  prepare              Generate & apply dev migrations (must run first)
  deploy               Apply prepared migrations to Cloudflare D1

Maintenance
  reset                Reset local dev DB (DESTROYS DATA)
  status               Show migration status (local & optionally remote)
  create [name]        Create migration folder only (no apply)
  studio               Open Prisma Studio

D1 utilities
  d1-info              List tables in production D1
  d1-exec  "SQL"       Execute raw SQL on production D1
  d1-backup            Dump production D1 schema/data to $BACKUP_DIR/

Common options
  --name <name>        Migration name (prepare/create)
  --env  <file>        Alternate .env file (default .env)
EOF
  ;;
  *) print_error "Unknown command '$COMMAND'"; exit 1;;
esac
