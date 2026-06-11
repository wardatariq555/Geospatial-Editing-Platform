# GIS Editing App

A full-stack GIS vector editing application built with React, Leaflet, Leaflet Draw, ASP.NET Core, PostgreSQL, and PostGIS.

The app lets a user upload zipped shapefiles, edit geometry and attributes in a browser map, persist edits in PostGIS, and download the edited layer back as a shapefile ZIP.

## Features

- Upload one ZIP containing one or more shapefiles.
- Supports point, line, multiline, polygon, and multipolygon layers.
- Enforces a 1000-feature upload limit per shapefile for UI responsiveness.
- Stores uploaded layers in PostgreSQL/PostGIS by browser editing session.
- Keeps all features in shared optimized tables using `SessionId` and `DatasetId`.
- Shows uploaded shapefiles as layers in the left panel.
- Layer controls include edit on/off, color, visibility, order, zoom, clear selection, and delete layer.
- Only one layer can be edited at a time.
- Draw tools are restricted to the active layer geometry type.
- Map, bottom attribute table, and right attribute panel stay synchronized.
- Save, delete, and add-field controls are available at the top of the attribute panel.
- Add, modify, and delete feature operations persist to the backend.
- Download exports the current edited layer as `.shp`, `.shx`, `.dbf`, `.cpg`, and `.prj` when projection text is available.
- If the original projection is missing, export writes a valid WGS84 `.prj` fallback.

## Project Structure

```text
GIS Editing App/
  Backend/      ASP.NET Core API, PostGIS persistence, shapefile import/export
  frontend/     React + Leaflet client
  .env.example  Deployment environment variable example
  .gitignore
  README.md
```

## Requirements

- .NET SDK 8 or newer
- Node.js 20 or newer
- PostgreSQL with PostGIS enabled
- Modern browser

## Database Setup

Create the database and enable PostGIS:

```sql
CREATE DATABASE gis_editing_app;
\c gis_editing_app
CREATE EXTENSION IF NOT EXISTS postgis;
```

The API uses `EnsureCreated` and startup compatibility SQL to create/update local tables. It also adds these older-database compatibility columns when missing:

- `datasets.SessionId`
- `datasets.ProjectionWkt`
- `features.SessionId`

## Environment

Frontend Vite env:

```text
frontend/.env
VITE_API_BASE_URL=http://localhost:5000/api
```

Backend environment variables can be set by your host, PowerShell, IIS, Docker, or deployment platform:

```text
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://localhost:5000
ConnectionStrings__Postgres=Host=localhost;Port=5432;Database=gis_editing_app;Username=postgres;Password=postgres
Cors__Origins__0=http://localhost:5173
Cors__Origins__1=http://127.0.0.1:5173
```

Examples are included in:

- `.env.example`
- `Backend/.env.example`
- `frontend/.env.example`

Note: ASP.NET Core does not automatically load `.env` files by itself. For deployment, set those variables in the server environment or deployment platform.

## Run Locally

Backend:

```powershell
cd "C:\Users\ITS\Documents\Codex\2026-06-06\GIS Editing App\Backend"
dotnet run
```

Default API URL:

```text
http://localhost:5000
```

Frontend:

```powershell
cd "C:\Users\ITS\Documents\Codex\2026-06-06\GIS Editing App\frontend"
npm install
npm run dev
```

Default frontend URL:

```text
http://127.0.0.1:5173
```

## Build For Deployment

Backend:

```powershell
cd "C:\Users\ITS\Documents\Codex\2026-06-06\GIS Editing App\Backend"
dotnet publish -c Release -o .\publish
```

Frontend:

```powershell
cd "C:\Users\ITS\Documents\Codex\2026-06-06\GIS Editing App\frontend"
npm install
npm run build
```

The frontend static build is created in:

```text
frontend/dist
```

Deploy `frontend/dist` with any static web server, and deploy `Backend/publish` as the API. Make sure `VITE_API_BASE_URL` points to the deployed API URL before running `npm run build`.

## Useful Test Commands

Backend compile check:

```powershell
cd "C:\Users\ITS\Documents\Codex\2026-06-06\GIS Editing App\Backend"
dotnet build
```

Frontend compile check:

```powershell
cd "C:\Users\ITS\Documents\Codex\2026-06-06\GIS Editing App\frontend"
npm run build
```

Frontend lint:

```powershell
cd "C:\Users\ITS\Documents\Codex\2026-06-06\GIS Editing App\frontend"
npm run lint
```

## Operational Notes

- Uploaded layers are isolated per browser session using `X-GIS-Editing-Session`.
- The frontend stores the session id in browser `localStorage`.
- Existing layers uploaded before `ProjectionWkt` support may need to be re-uploaded if you want the original `.prj` preserved on download.
- Browser-drawn geometries are treated as map/Leaflet coordinates. If you need true reprojection between coordinate systems, add a coordinate transformation step before storage/export.
- `.env`, build folders, `node_modules`, and generated shapefile artifacts are ignored by `.gitignore`.
