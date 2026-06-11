using Api.Models;

namespace Api.Services;

public interface IShapefileService
{
    Task<IReadOnlyList<ShapefileImport>> ReadZipAsync(IFormFile file, CancellationToken cancellationToken);
    Task<byte[]> WriteZipAsync(string datasetName, string? projectionWkt, IReadOnlyList<SpatialFeature> features, CancellationToken cancellationToken);
}

public sealed record ShapefileImport(string Name, string? ProjectionWkt, IReadOnlyList<SpatialFeature> Features);
