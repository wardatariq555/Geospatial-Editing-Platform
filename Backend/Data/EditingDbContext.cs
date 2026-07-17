using Api.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using System.Text.Json;

namespace Api.Data;

public sealed class EditingDbContext(DbContextOptions<EditingDbContext> options) : DbContext(options)
{
    public DbSet<SpatialDataset> Datasets => Set<SpatialDataset>();
    public DbSet<SpatialFeature> Features => Set<SpatialFeature>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasPostgresExtension("postgis");

        var dictionaryComparer = new ValueComparer<Dictionary<string, object?>>(
            (left, right) => JsonSerializer.Serialize(left, JsonOptions) == JsonSerializer.Serialize(right, JsonOptions),
            value => JsonSerializer.Serialize(value, JsonOptions).GetHashCode(),
            value => JsonSerializer.Deserialize<Dictionary<string, object?>>(
                JsonSerializer.Serialize(value, JsonOptions), JsonOptions) ?? new());

        modelBuilder.Entity<SpatialDataset>(entity =>
        {
            entity.ToTable("datasets");
            entity.HasKey(dataset => dataset.Id);
            entity.Property(dataset => dataset.SessionId).HasMaxLength(64).HasDefaultValue("default-session");
            entity.Property(dataset => dataset.Name).HasMaxLength(180);
            entity.Property(dataset => dataset.GeometryType).HasMaxLength(40);
            entity.Property(dataset => dataset.SourceFormat).HasMaxLength(20).HasDefaultValue("shp");
            entity.Property(dataset => dataset.ProjectionWkt).HasColumnType("text");
            entity.Property(dataset => dataset.CreatedAtUtc).HasDefaultValueSql("now()");
            entity.HasIndex(dataset => dataset.SessionId);
            entity.HasMany(dataset => dataset.Features)
                .WithOne(feature => feature.Dataset)
                .HasForeignKey(feature => feature.DatasetId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<SpatialFeature>(entity =>
        {
            entity.ToTable("features");
            entity.HasKey(feature => feature.Id);
            entity.Property(feature => feature.SessionId).HasMaxLength(64).HasDefaultValue("default-session");
            entity.Property(feature => feature.Geometry)
                .HasColumnType("geometry")
                .IsRequired();
            entity.Property(feature => feature.Properties)
                .HasColumnType("jsonb")
                .HasConversion(
                    value => JsonSerializer.Serialize(value, JsonOptions),
                    value => JsonSerializer.Deserialize<Dictionary<string, object?>>(value, JsonOptions) ?? new())
                .Metadata.SetValueComparer(dictionaryComparer);
            entity.HasIndex(feature => feature.DatasetId);
            entity.HasIndex(feature => new { feature.SessionId, feature.DatasetId });
            entity.HasIndex(feature => feature.Geometry).HasMethod("gist");
        });
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
