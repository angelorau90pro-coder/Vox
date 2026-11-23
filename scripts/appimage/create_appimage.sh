#!/bin/bash

# Exit on error
set -e

# Check platform
platform=$(uname)

if [[ "$platform" == "Darwin" ]]; then
    echo "Running on macOS. Note that the AppImage created will only work on Linux systems."
    if ! command -v docker &> /dev/null; then
        echo "Docker Desktop for Mac is not installed. Please install it from https://www.docker.com/products/docker-desktop"
        exit 1
    fi
elif [[ "$platform" == "Linux" ]]; then
    echo "Running on Linux. Proceeding with AppImage creation..."
else
    echo "This script is intended to run on macOS or Linux. Current platform: $platform"
    exit 1
fi

# Enable BuildKit
export DOCKER_BUILDKIT=1

BUILD_IMAGE_NAME="vox-appimage-builder"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Please start Docker first."
    exit 1
fi

# Check and install Buildx if needed
if ! docker buildx version >/dev/null 2>&1; then
    echo "Installing Docker Buildx..."
    mkdir -p ~/.docker/cli-plugins/
    curl -SL https://github.com/docker/buildx/releases/download/v0.13.1/buildx-v0.13.1.linux-amd64 -o ~/.docker/cli-plugins/docker-buildx
    chmod +x ~/.docker/cli-plugins/docker-buildx
fi

# Download appimagetool if not present
if [ ! -f "appimagetool" ]; then
    echo "Downloading appimagetool..."
    wget -O appimagetool "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x appimagetool
fi

# Delete any existing AppImage to avoid bloating the build
rm -f Vox-x86_64.AppImage

# Create build Dockerfile
echo "Creating build Dockerfile..."
cat > Dockerfile.build << 'EOF'
# syntax=docker/dockerfile:1
FROM ubuntu:20.04

# Install required dependencies
RUN apt-get update && apt-get install -y \
    libfuse2 \
    libglib2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libasound2 \
    libdrm2 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
EOF

# Create .dockerignore file
echo "Creating .dockerignore file..."
cat > .dockerignore << EOF
Dockerfile.build
.dockerignore
.git
.gitignore
.DS_Store
*~
*.swp
*.swo
*.tmp
*.bak
*.log
*.err
node_modules/
venv/
*.egg-info/
*.tox/
dist/
EOF

# Build Docker image without cache
echo "Building Docker image (no cache)..."
docker build --no-cache -t "$BUILD_IMAGE_NAME" -f Dockerfile.build .

# Create AppImage using local appimagetool
echo "Creating AppImage..."
docker run --rm --privileged -v "$(pwd):/app" "$BUILD_IMAGE_NAME" bash -c '
cd /app && \
rm -rf VoxApp.AppDir && \
mkdir -p VoxApp.AppDir/usr/bin VoxApp.AppDir/usr/lib VoxApp.AppDir/usr/share/applications && \
find . -maxdepth 1 ! -name VoxApp.AppDir ! -name "." ! -name ".." -exec cp -r {} VoxApp.AppDir/usr/bin/ \; && \
cp vox.png VoxApp.AppDir/ && \
echo "[Desktop Entry]" > VoxApp.AppDir/vox.desktop && \
echo "Name=Vox" >> VoxApp.AppDir/vox.desktop && \
echo "Comment=Open source AI code editor." >> VoxApp.AppDir/vox.desktop && \
echo "GenericName=Text Editor" >> VoxApp.AppDir/vox.desktop && \
echo "Exec=vox %F" >> VoxApp.AppDir/vox.desktop && \
echo "Icon=vox" >> VoxApp.AppDir/vox.desktop && \
echo "Type=Application" >> VoxApp.AppDir/vox.desktop && \
echo "StartupNotify=false" >> VoxApp.AppDir/vox.desktop && \
echo "StartupWMClass=Vox" >> VoxApp.AppDir/vox.desktop && \
echo "Categories=TextEditor;Development;IDE;" >> VoxApp.AppDir/vox.desktop && \
echo "MimeType=application/x-vox-workspace;" >> VoxApp.AppDir/vox.desktop && \
echo "Keywords=vox;" >> VoxApp.AppDir/vox.desktop && \
echo "Actions=new-empty-window;" >> VoxApp.AppDir/vox.desktop && \
echo "[Desktop Action new-empty-window]" >> VoxApp.AppDir/vox.desktop && \
echo "Name=New Empty Window" >> VoxApp.AppDir/vox.desktop && \
echo "Name[de]=Neues leeres Fenster" >> VoxApp.AppDir/vox.desktop && \
echo "Name[es]=Nueva ventana vacía" >> VoxApp.AppDir/vox.desktop && \
echo "Name[fr]=Nouvelle fenêtre vide" >> VoxApp.AppDir/vox.desktop && \
echo "Name[it]=Nuova finestra vuota" >> VoxApp.AppDir/vox.desktop && \
echo "Name[ja]=新しい空のウィンドウ" >> VoxApp.AppDir/vox.desktop && \
echo "Name[ko]=새 빈 창" >> VoxApp.AppDir/vox.desktop && \
echo "Name[ru]=Новое пустое окно" >> VoxApp.AppDir/vox.desktop && \
echo "Name[zh_CN]=新建空窗口" >> VoxApp.AppDir/vox.desktop && \
echo "Name[zh_TW]=開新空視窗" >> VoxApp.AppDir/vox.desktop && \
echo "Exec=vox --new-window %F" >> VoxApp.AppDir/vox.desktop && \
echo "Icon=vox" >> VoxApp.AppDir/vox.desktop && \
chmod +x VoxApp.AppDir/vox.desktop && \
cp VoxApp.AppDir/vox.desktop VoxApp.AppDir/usr/share/applications/ && \
echo "[Desktop Entry]" > VoxApp.AppDir/vox-url-handler.desktop && \
echo "Name=Vox - URL Handler" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "Comment=Open source AI code editor." >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "GenericName=Text Editor" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "Exec=vox --open-url %U" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "Icon=vox" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "Type=Application" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "NoDisplay=true" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "StartupNotify=true" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "Categories=Utility;TextEditor;Development;IDE;" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "MimeType=x-scheme-handler/vox;" >> VoxApp.AppDir/vox-url-handler.desktop && \
echo "Keywords=vox;" >> VoxApp.AppDir/vox-url-handler.desktop && \
chmod +x VoxApp.AppDir/vox-url-handler.desktop && \
cp VoxApp.AppDir/vox-url-handler.desktop VoxApp.AppDir/usr/share/applications/ && \
echo "#!/bin/bash" > VoxApp.AppDir/AppRun && \
echo "HERE=\$(dirname \"\$(readlink -f \"\${0}\")\")" >> VoxApp.AppDir/AppRun && \
echo "export PATH=\${HERE}/usr/bin:\${PATH}" >> VoxApp.AppDir/AppRun && \
echo "export LD_LIBRARY_PATH=\${HERE}/usr/lib:\${LD_LIBRARY_PATH}" >> VoxApp.AppDir/AppRun && \
echo "exec \${HERE}/usr/bin/vox --no-sandbox \"\$@\"" >> VoxApp.AppDir/AppRun && \
chmod +x VoxApp.AppDir/AppRun && \
chmod -R 755 VoxApp.AppDir && \

# Strip unneeded symbols from the binary to reduce size
strip --strip-unneeded VoxApp.AppDir/usr/bin/vox

ls -la VoxApp.AppDir/ && \
ARCH=x86_64 ./appimagetool -n VoxApp.AppDir Vox-x86_64.AppImage
'

# Clean up
rm -rf VoxApp.AppDir .dockerignore appimagetool

echo "AppImage creation complete! Your AppImage is: Vox-x86_64.AppImage"
