using NetTopologySuite.Geometries;

namespace Api.Contracts;

public sealed record DatasetSummary(Guid Id, string Name, string GeometryType, int FeatureCount, DateTime CreatedAtUtc);

public sealed record FeatureCollectionDto(
    string Type,
    Guid DatasetId,
    string Name,
    string GeometryType,
    IReadOnlyList<FeatureDto> Features);

public sealed record FeatureDto(
    string Type,
    Guid? Id,
    Geometry Geometry,
    Dictionary<string, object?> Properties);

public sealed record SaveFeatureCollectionRequest(IReadOnlyList<FeatureDto> Features);
