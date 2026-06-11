# GIS Editing App

A full-stack web application for editing GIS vector data in the browser.

Users can upload zipped shapefiles, view layers on a Leaflet map, edit feature geometry and attributes, persist changes in PostgreSQL/PostGIS, and download the edited layer back as a shapefile ZIP.

## Project Flow

1. A user uploads a ZIP file containing one or more shapefiles.
2. The backend reads each `.shp`, `.shx`, `.dbf`, and optional `.prj` file.
3. Each shapefile becomes a layer in the left panel.
4. Features are stored in PostgreSQL/PostGIS with:
   - `SessionId` to isolate each browser/user session
   - `DatasetId` to link features to their shapefile layer
5. The frontend loads visible layers onto the Leaflet map.
6. The user can start editing one layer at a time.
7. Geometry edits and attribute edits are saved through the API.
8. The backend updates PostGIS and returns the refreshed layer.
9. The user downloads the edited layer as a shapefile ZIP.

## Main Features

- Upload a single ZIP containing one or multiple shapefiles.
- Supports point, line, multiline, polygon, and multipolygon layers.
- Rejects shapefiles with more than 1000 features for browser responsiveness.
- Stores geometry in PostGIS and attributes as JSONB.
- Keeps map, attribute table, and attribute editor synchronized.
- Allows only one active editable layer at a time.
- Restricts drawing tools to the active layer geometry type.
- Supports add, update, and delete feature workflows.
- Preserves the original uploaded `.prj` projection text when available.
- Writes a valid WGS84 `.prj` fallback when projection text is missing.
- Exports edited layers as zipped shapefiles.

## Tech Stack

- Frontend: React, Vite, Leaflet, Leaflet Draw
- Backend: ASP.NET Core Web API
- Database: PostgreSQL with PostGIS
- GIS I/O: NetTopologySuite shapefile support

## Repository Structure

```text
.
├── Backend/          # ASP.NET Core API and shapefile import/export logic
├── frontend/         # React + Leaflet client
├── .env.example      # Example environment variables
├── .gitignore
└── README.md
```

## Requirements

- .NET SDK 8 or newer
- Node.js 20 or newer
- PostgreSQL
- PostGIS extension

## Database Setup

Create the database:

```sql
CREATE DATABASE gis_editing_app;
```

Enable PostGIS:

```sql
\c gis_editing_app
CREATE EXTENSION IF NOT EXISTS postgis;
```

The backend creates the required tables automatically on startup. It also applies small compatibility SQL for older local databases.

## Environment Variables

Root example:

```text
.env.example
```

Backend example:

```text
Backend/.env.example
```

Frontend example:

```text
frontend/.env.example
```

Frontend Vite variable:

```text
VITE_API_BASE_URL=http://localhost:5000/api
```

Backend variables:

```text
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://localhost:5000
ConnectionStrings__Postgres=Host=localhost;Port=5432;Database=gis_editing_app;Username=postgres;Password=postgres
Cors__Origins__0=http://localhost:5173
Cors__Origins__1=http://127.0.0.1:5173
```

ASP.NET Core does not automatically load `.env` files. In production, set these variables in your hosting environment, Docker container, IIS configuration, or deployment platform.

## Run Locally

Start the backend:

```powershell
cd Backend
dotnet run
```

Default backend URL:

```text
http://localhost:5000
```

Install frontend dependencies:

```powershell
cd frontend
npm install
```

Start the frontend:

```powershell
npm run dev
```

Default frontend URL:

```text
http://127.0.0.1:5173
```

## Build

Backend:

```powershell
cd Backend
dotnet build
```

Frontend:

```powershell
cd frontend
npm run build
```

The frontend build output is created in:

```text
frontend/dist
```

## Deployment

Publish the backend:

```powershell
cd Backend
dotnet publish -c Release -o publish
```

Build the frontend:

```powershell
cd frontend
npm install
npm run build
```

Deploy:

- `Backend/publish` as the API application
- `frontend/dist` as static frontend files

Before building the frontend for production, set:

```text
VITE_API_BASE_URL=https://your-api-domain.example/api
```

Also configure backend CORS so the deployed frontend domain is allowed.

## API Overview

Main API route:

```text
/api/datasets
```

Common operations:

- `GET /api/datasets` lists datasets for the current session.
- `POST /api/datasets/upload` uploads zipped shapefiles.
- `GET /api/datasets/{id}` loads one layer as GeoJSON-like data.
- `POST /api/datasets/{id}/features` adds a feature.
- `PUT /api/datasets/{id}/features` updates layer features.
- `DELETE /api/datasets/{id}/features/{featureId}` deletes a feature.
- `GET /api/datasets/{id}/download` downloads the edited shapefile ZIP.
- `DELETE /api/datasets/{id}` deletes a layer.

The frontend sends `X-GIS-Editing-Session` so each browser session works with its own layer data.

## Notes

- Uploaded shapefiles should include `.shp`, `.shx`, and `.dbf`.
- Include `.prj` if you want the original spatial reference preserved exactly.
- Existing layers uploaded before projection storage was added may need to be re-uploaded.
- Browser-drawn features are handled in the map coordinate system. If a production workflow requires true reprojection between coordinate systems, add a coordinate transformation step before storage/export.
- Generated shapefile artifacts, build folders, `node_modules`, and local `.env` files are ignored by Git.
