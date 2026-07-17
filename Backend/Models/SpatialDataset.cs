namespace Api.Models;

public sealed class SpatialDataset
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string SessionId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string GeometryType { get; set; } = "Unknown";
    public string SourceFormat { get; set; } = "shp";
    public string? ProjectionWkt { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public List<SpatialFeature> Features { get; set; } = [];
}
