#!/usr/bin/env bash

# =====================================
# SegCut Installer / Updater / Remover
# =====================================

set -e

APP_NAME="SegCut"
REPO_ZIP_URL="https://github.com/madhanmaaz/SegCut/archive/refs/heads/main.zip"
PACKAGE_JSON_URL="https://raw.githubusercontent.com/madhanmaaz/SegCut/refs/heads/main/package.json"

INSTALL_ROOT="$HOME/.local/share/$APP_NAME"
BIN_LINK="$HOME/.local/bin/segcut"
TMP_DIR="/tmp/segcut_install"
ZIP_FILE="$TMP_DIR/segcut.zip"

ACTION="$1"

# ------------------------
# Helpers
# ------------------------
log() {
    echo -e "\n==> $1"
}

ensure_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

clean_tmp() {
    rm -rf "$TMP_DIR"
}

# ------------------------
# Install Node.js
# ------------------------
ensure_node() {
    if ensure_command node; then
        log "Node.js already installed"
        return
    fi

    log "Installing Node.js..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install node
    else
        if ensure_command apt; then
            sudo apt update
            sudo apt install -y nodejs npm
        elif ensure_command dnf; then
            sudo dnf install -y nodejs npm
        else
            echo "Unsupported package manager. Install Node.js manually."
            exit 1
        fi
    fi
}

# ------------------------
# Install FFmpeg
# ------------------------
ensure_ffmpeg() {
    if ensure_command ffmpeg; then
        log "FFmpeg already installed"
        return
    fi

    log "Installing FFmpeg..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install ffmpeg
    else
        if ensure_command apt; then
            sudo apt install -y ffmpeg
        elif ensure_command dnf; then
            sudo dnf install -y ffmpeg
        else
            echo "Unsupported package manager. Install FFmpeg manually."
            exit 1
        fi
    fi
}

# ------------------------
# Download App
# ------------------------
download_and_extract() {
    log "Downloading latest version..."

    clean_tmp
    mkdir -p "$TMP_DIR"

    curl -L "$REPO_ZIP_URL" -o "$ZIP_FILE"
    unzip -q "$ZIP_FILE" -d "$TMP_DIR"

    EXTRACTED_FOLDER=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)

    rm -rf "$INSTALL_ROOT"
    mkdir -p "$INSTALL_ROOT"

    cp -R "$EXTRACTED_FOLDER"/* "$INSTALL_ROOT"

    clean_tmp
}

# ------------------------
# Version Check
# ------------------------
get_remote_version() {
    curl -s "$PACKAGE_JSON_URL" | grep '"version"' | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/'
}

get_local_version() {
    if [ ! -f "$INSTALL_ROOT/package.json" ]; then
        echo ""
        return
    fi
    grep '"version"' "$INSTALL_ROOT/package.json" | head -1 | sed -E 's/.*"version": *"([^"]+)".*/\1/'
}

# ------------------------
# Create CLI Link
# ------------------------
create_symlink() {
    mkdir -p "$HOME/.local/bin"

    cat > "$INSTALL_ROOT/run.sh" <<EOF
#!/usr/bin/env bash
cd "$INSTALL_ROOT"
node main.js
EOF

    chmod +x "$INSTALL_ROOT/run.sh"
    ln -sf "$INSTALL_ROOT/run.sh" "$BIN_LINK"

    log "Command available as: segcut"
    log "Make sure \$HOME/.local/bin is in your PATH"
}

# ------------------------
# Install
# ------------------------
install_app() {
    log "Installing $APP_NAME..."

    ensure_node
    ensure_ffmpeg
    download_and_extract

    cd "$INSTALL_ROOT"
    npm install --silent

    create_symlink

    log "$APP_NAME installed successfully!"
}

# ------------------------
# Update
# ------------------------
update_app() {
    log "Checking for updates..."

    LOCAL_VERSION=$(get_local_version)
    REMOTE_VERSION=$(get_remote_version)

    if [ "$LOCAL_VERSION" == "$REMOTE_VERSION" ]; then
        log "Already up to date (v$LOCAL_VERSION)"
        exit 0
    fi

    log "Updating from v$LOCAL_VERSION to v$REMOTE_VERSION"

    download_and_extract

    cd "$INSTALL_ROOT"
    npm install --silent

    log "Update complete!"
}

# ------------------------
# Uninstall
# ------------------------
uninstall_app() {
    log "Removing $APP_NAME..."

    rm -rf "$INSTALL_ROOT"
    rm -f "$BIN_LINK"

    log "$APP_NAME removed successfully!"
}

# ------------------------
# Entry
# ------------------------
case "$ACTION" in
    --install)
        install_app
        ;;
    --update)
        update_app
        ;;
    --uninstall)
        uninstall_app
        ;;
    *)
        echo "Usage: ./install.sh --install | --update | --uninstall"
        exit 1
        ;;
esac
