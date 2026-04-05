#!/bin/zsh
set -euo pipefail
setopt null_glob

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGES_DIR="$ROOT_DIR/qa/images"

if [[ ! -d "$IMAGES_DIR" ]]; then
  echo "Missing images directory: $IMAGES_DIR" >&2
  exit 1
fi

typeset -a image_files
image_files=(
  "$IMAGES_DIR"/**/*.png(N)
  "$IMAGES_DIR"/**/*.jpg(N)
  "$IMAGES_DIR"/**/*.jpeg(N)
  "$IMAGES_DIR"/**/*.heic(N)
  "$IMAGES_DIR"/**/*.heif(N)
  "$IMAGES_DIR"/*.png(N)
  "$IMAGES_DIR"/*.jpg(N)
  "$IMAGES_DIR"/*.jpeg(N)
  "$IMAGES_DIR"/*.heic(N)
  "$IMAGES_DIR"/*.heif(N)
)

if [[ ${#image_files[@]} -eq 0 ]]; then
  echo "No images found in $IMAGES_DIR" >&2
  exit 1
fi

for image_path in "${image_files[@]}"; do
  xcrun simctl addmedia booted "$image_path"
  echo "Imported $(basename "$image_path")"
done
