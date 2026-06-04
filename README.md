# SpatialTimber Furnisher

Monorepo containing the two halves of the Spatial Timber furnisher system:

- **`furnisher-engine/`** — the placement engine (TypeScript). Contains the layout/placement/scoring logic, the furniture library, plus a Storybook + Vite demo harness.
- **`furnisher-app/`** — the React frontend. Interactive SVG canvas for drawing apartment floor plans, placing doors, and triggering automatic furniture placement via the engine.

The app consumes the engine through path aliases (`@engine`, `@layout`, `@library`) that resolve to `../furnisher-engine/src/*`, so the two folders **must remain siblings**.

## Setup

Install dependencies in each package:

```powershell
cd furnisher-engine; npm install
cd ../furnisher-app; npm install
```

## Running locally

**App** (the main frontend):

```powershell
cd furnisher-app
npm run dev          # serves on http://127.0.0.1:5173
```

**Engine** (demo / Storybook harness):

```powershell
cd furnisher-engine
npm run dev          # Vite demo
npm run storybook    # Storybook on port 7007
```

See each package's own `README.md` for details.
