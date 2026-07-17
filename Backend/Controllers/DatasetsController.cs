using Api.Contracts;
using Api.Data;
using Api.Models;
using Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using NetTopologySuite.Geometries;
using Npgsql;

namespace Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public sealed class DatasetsController(EditingDbContext db, IShapefileService shapefileService) : ControllerBase
{
    // Return lightweight layer records for the left sidebar.
    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<DatasetSummary>>> List(CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId();
        var datasets = await db.Datasets
            .Where(dataset => dataset.SessionId == sessionId)
            .OrderByDescending(dataset => dataset.CreatedAtUtc)
            .Select(dataset => new DatasetSummary(
                dataset.Id,
                dataset.Name,
                dataset.GeometryType,
                dataset.SourceFormat,
                db.Features.Count(feature => feature.DatasetId == dataset.Id),
                dataset.CreatedAtUtc))
            .ToListAsync(cancellationToken);

        return Ok(datasets);
    }

    // Receive one ZIP upload, import every shapefile inside it, and persist each shapefile as one PostGIS dataset.
    [HttpPost("upload")]
    [RequestSizeLimit(200_000_000)]
    public async Task<ActionResult<IReadOnlyList<DatasetSummary>>> Upload([FromForm] IFormFile file, CancellationToken cancellationToken)
    {
        if (file is null)
        {
            return BadRequest("Upload a .zip that contains .shp, .shx, and .dbf files.");
        }

        IReadOnlyList<ShapefileImport> imports;
        try
        {
            imports = await shapefileService.ReadAsync(file, cancellationToken);
        }
        catch (InvalidOperationException exception)
        {
            // Return only the upload validation message so the UI does not show a development stack trace.
            return BadRequest(exception.Message);
        }

        if (imports.Count == 0)
        {
            return BadRequest("No features were found in the uploaded shapefile.");
        }

        var sessionId = GetSessionId();
        var importRows = imports.Select(import =>
            {
                var datasetId = Guid.NewGuid();
                var features = import.Features.Select(feature =>
                {
                    feature.DatasetId = datasetId;
                    feature.SessionId = sessionId;
                    return feature;
                }).ToList();

                // Assign DatasetId explicitly so imported rows always link to the sidebar layer count and download filter.
                var dataset = new SpatialDataset
                {
                    Id = datasetId,
                    SessionId = sessionId,
                    Name = import.Name,
                    GeometryType = features.First().Geometry.GeometryType,
                    SourceFormat = import.SourceFormat,
                    ProjectionWkt = import.ProjectionWkt,
                    Features = []
                };
                return new { Dataset = dataset, Features = features };
            })
            .ToList();

        var datasets = importRows.Select(row => row.Dataset).ToList();
        var features = importRows.SelectMany(row => row.Features).ToList();
        db.Datasets.AddRange(datasets);
        db.Features.AddRange(features);
        await db.SaveChangesAsync(cancellationToken);

        return Ok(importRows.Select(row =>
            new DatasetSummary(
                row.Dataset.Id,
                row.Dataset.Name,
                row.Dataset.GeometryType,
                row.Dataset.SourceFormat,
                row.Features.Count,
                row.Dataset.CreatedAtUtc)).ToList());
    }

    // Return one persisted dataset as a GeoJSON-like FeatureCollection for Leaflet editing.
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<FeatureCollectionDto>> Get(Guid id, CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId();
        var dataset = await db.Datasets
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == id && item.SessionId == sessionId, cancellationToken);

        if (dataset is null)
        {
            return NotFound();
        }

        var features = await LoadFeaturesAsync(id, cancellationToken);
        return Ok(ToFeatureCollection(dataset, features));
    }

    // Synchronize the edited layer by updating existing features, adding new features, and deleting removed ones.
    [HttpPut("{id:guid}/features")]
    public async Task<ActionResult<FeatureCollectionDto>> SaveFeatures(
        Guid id,
        SaveFeatureCollectionRequest request,
        CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId();
        var dataset = await db.Datasets
            .FirstOrDefaultAsync(item => item.Id == id && item.SessionId == sessionId, cancellationToken);

        if (dataset is null)
        {
            return NotFound();
        }

        try
        {
            var incomingFeatures = request.Features
                .Where(feature => feature.Geometry is not null)
                .ToList();

            if (incomingFeatures.Any(feature => !MatchesDatasetGeometry(dataset.GeometryType, feature.Geometry)))
            {
                return BadRequest($"Draw only {dataset.GeometryType} features in this layer.");
            }

            // Replace this layer's feature rows in one transaction. This avoids stale-row concurrency errors
            // when the browser and database disagree about individual feature ids after several edit attempts.
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            await db.Features
                .Where(feature => feature.DatasetId == dataset.Id && feature.SessionId == sessionId)
                .ExecuteDeleteAsync(cancellationToken);

            var replacementFeatures = incomingFeatures.Select(incomingFeature =>
            {
                incomingFeature.Geometry.SRID = NormalizeSrid(incomingFeature.Geometry.SRID);
                return new SpatialFeature
                {
                    Id = incomingFeature.Id ?? Guid.NewGuid(),
                    SessionId = sessionId,
                    DatasetId = dataset.Id,
                    Geometry = incomingFeature.Geometry,
                    Properties = incomingFeature.Properties
                };
            }).ToList();

            db.Features.AddRange(replacementFeatures);

            dataset.GeometryType = replacementFeatures.FirstOrDefault()?.Geometry.GeometryType ?? dataset.GeometryType;

            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);

            // Reload from PostGIS so newly inserted features return with database ids and the latest count.
            return Ok(await LoadFeatureCollectionAsync(id, sessionId, cancellationToken));
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException postgresException)
        {
            // Return the database error as a short API message instead of an unreadable browser 500.
            return StatusCode(StatusCodes.Status500InternalServerError, $"Database could not save this edit: {postgresException.MessageText}");
        }
        catch (InvalidOperationException exception)
        {
            // Return known save/export validation failures as plain text for the status bar.
            return BadRequest(exception.Message);
        }
        catch (Exception exception)
        {
            // Surface unexpected save failures as concise text so the frontend can show the real cause.
            return StatusCode(StatusCodes.Status500InternalServerError, $"Save failed: {exception.GetBaseException().Message}");
        }
    }

    // Add one newly drawn feature to the current session/layer, then return the refreshed layer.
    [HttpPost("{id:guid}/features")]
    public async Task<ActionResult<FeatureCollectionDto>> AddFeature(
        Guid id,
        FeatureDto request,
        CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId();
        var dataset = await db.Datasets
            .FirstOrDefaultAsync(item => item.Id == id && item.SessionId == sessionId, cancellationToken);

        if (dataset is null)
        {
            return NotFound();
        }

        if (request.Geometry is null)
        {
            return BadRequest("Draw a valid geometry before saving.");
        }

        if (!MatchesDatasetGeometry(dataset.GeometryType, request.Geometry))
        {
            return BadRequest($"Draw only {dataset.GeometryType} features in this layer.");
        }

        try
        {
            request.Geometry.SRID = NormalizeSrid(request.Geometry.SRID);
            db.Features.Add(new SpatialFeature
            {
                SessionId = sessionId,
                DatasetId = dataset.Id,
                Geometry = request.Geometry,
                Properties = request.Properties
            });

            await db.SaveChangesAsync(cancellationToken);
            return Ok(await LoadFeatureCollectionAsync(dataset.Id, sessionId, cancellationToken));
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException postgresException)
        {
            // Return the database error as a short API message instead of an unreadable browser 500.
            return StatusCode(StatusCodes.Status500InternalServerError, $"Database could not add this feature: {postgresException.MessageText}");
        }
        catch (Exception exception)
        {
            // Surface unexpected insert failures as concise text so the frontend can show the real cause.
            return StatusCode(StatusCodes.Status500InternalServerError, $"Add feature failed: {exception.GetBaseException().Message}");
        }
    }

    // Delete one selected feature from the current session/layer, then return the refreshed layer.
    [HttpDelete("{id:guid}/features/{featureId:guid}")]
    public async Task<ActionResult<FeatureCollectionDto>> DeleteFeature(
        Guid id,
        Guid featureId,
        CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId();
        var datasetExists = await db.Datasets
            .AnyAsync(item => item.Id == id && item.SessionId == sessionId, cancellationToken);

        if (!datasetExists)
        {
            return NotFound();
        }

        var deletedCount = await db.Features
            .Where(feature => feature.Id == featureId && feature.DatasetId == id)
            .ExecuteDeleteAsync(cancellationToken);

        if (deletedCount == 0)
        {
            return NotFound("Selected feature was not found in this layer.");
        }

        return Ok(await LoadFeatureCollectionAsync(id, sessionId, cancellationToken));
    }

    // Export the current database version of one dataset back to a zipped shapefile.
    [HttpGet("{id:guid}/download")]
    public async Task<IActionResult> Download(Guid id, CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId();
        var dataset = await db.Datasets
            .AsNoTracking()
            .FirstOrDefaultAsync(item => item.Id == id && item.SessionId == sessionId, cancellationToken);

        if (dataset is null)
        {
            return NotFound();
        }

        var features = await LoadFeaturesAsync(id, cancellationToken);
        var export = await shapefileService.WriteAsync(dataset.Name, dataset.ProjectionWkt, dataset.SourceFormat, features, cancellationToken);
        return File(export.Bytes, export.ContentType, export.FileName);
    }

    // Delete one layer and all of its persisted features from PostGIS.
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId();
        var dataset = await db.Datasets
            .FirstOrDefaultAsync(item => item.Id == id && item.SessionId == sessionId, cancellationToken);

        if (dataset is null)
        {
            return NotFound();
        }

        // Remove features explicitly so delete works even if an older database was created without cascade rules.
        await db.Features
            .Where(feature => feature.DatasetId == id)
            .ExecuteDeleteAsync(cancellationToken);
        db.Datasets.Remove(dataset);
        await db.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    // Convert database entities into the browser contract.
    private static FeatureCollectionDto ToFeatureCollection(SpatialDataset dataset) =>
        ToFeatureCollection(dataset, dataset.Features);

    // Convert database entities and an explicitly loaded feature list into the browser contract.
    private static FeatureCollectionDto ToFeatureCollection(SpatialDataset dataset, IReadOnlyList<SpatialFeature> features) =>
        new(
            "FeatureCollection",
            dataset.Id,
            dataset.Name,
            dataset.GeometryType,
            features.Select(feature => new FeatureDto(
                "Feature",
                feature.Id,
                feature.Geometry,
                feature.Properties)).ToList());

    // Convert database entities into the sidebar list contract.
    private static DatasetSummary ToSummary(SpatialDataset dataset) =>
        new(dataset.Id, dataset.Name, dataset.GeometryType, dataset.SourceFormat, dataset.Features.Count, dataset.CreatedAtUtc);

    // Reload one layer after save/add so the browser receives fresh ids, attributes, and feature count.
    private async Task<FeatureCollectionDto> LoadFeatureCollectionAsync(Guid datasetId, string sessionId, CancellationToken cancellationToken)
    {
        var dataset = await db.Datasets
            .AsNoTracking()
            .FirstAsync(item => item.Id == datasetId && item.SessionId == sessionId, cancellationToken);
        var features = await LoadFeaturesAsync(datasetId, cancellationToken);
        return ToFeatureCollection(dataset, features);
    }

    // Load feature rows directly from the features table so map rendering does not depend on EF navigation loading.
    private async Task<List<SpatialFeature>> LoadFeaturesAsync(Guid datasetId, CancellationToken cancellationToken) =>
        await db.Features
            .AsNoTracking()
            .Where(feature => feature.DatasetId == datasetId)
            .OrderBy(feature => feature.Id)
            .ToListAsync(cancellationToken);

    // Keep Leaflet Draw from mixing points, lines, and polygons inside one shapefile layer.
    private static bool MatchesDatasetGeometry(string datasetGeometryType, Geometry geometry)
    {
        var expected = GeometryFamily(datasetGeometryType);
        var actual = GeometryFamily(geometry.GeometryType);
        return expected == "Unknown" || actual == "Unknown" || expected == actual;
    }

    // Group single and multi geometries into the shapefile families users recognize.
    private static string GeometryFamily(string geometryType)
    {
        if (geometryType.Contains("Point", StringComparison.OrdinalIgnoreCase)) return "Point";
        if (geometryType.Contains("LineString", StringComparison.OrdinalIgnoreCase)) return "Line";
        if (geometryType.Contains("Polygon", StringComparison.OrdinalIgnoreCase)) return "Polygon";
        return "Unknown";
    }

    // Store browser-drawn Leaflet geometry as WGS84 when no SRID is present.
    private static int NormalizeSrid(int srid) => srid <= 0 ? 4326 : srid;

    // Keep each browser/user working in an isolated editing session while using shared optimized tables.
    private string GetSessionId()
    {
        var value = Request.Headers["X-GIS-Editing-Session"].FirstOrDefault()
            ?? Request.Query["sessionId"].FirstOrDefault()
            ?? "default-session";
        var clean = new string(value.Where(character => char.IsLetterOrDigit(character) || character == '-').Take(64).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "default-session" : clean;
    }
}
