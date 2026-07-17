using Api.Models;

namespace Api.Services;

public interface IShapefileService
{
    Task<IReadOnlyList<ShapefileImport>> ReadAsync(IFormFile file, CancellationToken cancellationToken);
    Task<ExportResult> WriteAsync(string datasetName, string? projectionWkt, string sourceFormat, IReadOnlyList<SpatialFeature> features, CancellationToken cancellationToken);
}

public sealed record ShapefileImport(string Name, string? ProjectionWkt, string SourceFormat, IReadOnlyList<SpatialFeature> Features);

public sealed record ExportResult(byte[] Bytes, string ContentType, string FileName);
