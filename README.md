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


## Notes

- Uploaded shapefiles should include `.shp`, `.shx`, and `.dbf`.
- Include `.prj` if you want the original spatial reference preserved exactly.
- Existing layers uploaded before projection storage was added may need to be re-uploaded.
- Browser-drawn features are handled in the map coordinate system. If a production workflow requires true reprojection between coordinate systems, add a coordinate transformation step before storage/export.
- Generated shapefile artifacts, build folders, `node_modules`, and local `.env` files are ignored by Git.
