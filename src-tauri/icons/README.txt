Drop your icon here before running `pnpm tauri build`.

Quickest way: have a 1024x1024 PNG named source-icon.png, then run:

  pnpm tauri icon ./path/to/source-icon.png

That generates all the sizes the bundler expects:
  - 32x32.png
  - 128x128.png
  - 128x128@2x.png
  - icon.icns (macOS)
  - icon.ico  (Windows)
  - Square*Logo.png (Windows Store / Microsoft Store)

Dev mode (`pnpm tauri dev`) works fine without any icons — Tauri falls
back to its built-in default.
