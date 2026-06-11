using NetTopologySuite.Geometries;

namespace Api.Models;

public sealed class SpatialFeature
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string SessionId { get; set; } = string.Empty;
    public Guid DatasetId { get; set; }
    public SpatialDataset? Dataset { get; set; }
    public Geometry Geometry { get; set; } = default!;
    public Dictionary<string, object?> Properties { get; set; } = [];
}
