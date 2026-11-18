# Changelog

All notable changes to the **Convey** extension will be documented in this file.  
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-18

### Added
- Interactive 2D convolution visualizer webview (`Convey: Open Visualizer`) supporting `WIDTH`, `HEIGHT`, `kernel_size`, `stride`, `padding`, `dilation` as values or `(H, W)` tuples, `C_in`, `C_out`, and `Bias` (`0` or `1`).
- Hover inspection across both Input and Output grids plus an animated **Play Sweep** mode with a **1x-4x** speed slider.
- Automatic detection and warning for unreached input/padding cells that do not contribute to the output.
- Live output shape calculation, learnable parameter count (`C_out × (C_in × kH × kW + Bias)`), and `nn.Flatten()` output size.
- Proportional overview rendering mode for grids exceeding 64 cells per side.
- Python CodeLens (`Visualize in Convey`), editor context menu item, and `Convey: Visualize Conv2d Under Cursor` command for parsing `Conv2d(...)` calls directly from editor code.
- Theme-aware styling and webview state persistence across reloads.
