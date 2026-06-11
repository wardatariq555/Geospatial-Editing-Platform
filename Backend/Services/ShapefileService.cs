using Api.Models;
using NetTopologySuite.Features;
using NetTopologySuite.IO.Esri;
using System.Globalization;
using System.IO.Compression;
using System.Text;

namespace Api.Services;

public sealed class ShapefileService : IShapefileService
{
    private const int MaxFeaturesPerShapefile = 1000;
    private const string Wgs84ProjectionWkt =
        "GEOGCS[\"GCS_WGS_1984\",DATUM[\"D_WGS_1984\",SPHEROID[\"WGS_1984\",6378137.0,298.257223563]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]]";
    private enum DbfExportKind { Text, Integer, Number, Boolean, Date }
    private sealed record DbfFieldMapping(string SourceName, string DbfName, DbfExportKind Kind);

    // Extract one uploaded ZIP and import every complete .shp/.shx/.dbf shapefile set inside it.
    public async Task<IReadOnlyList<ShapefileImport>> ReadZipAsync(IFormFile file, CancellationToken cancellationToken)
    {
        if (file.Length == 0)
        {
            throw new InvalidOperationException("Uploaded file is empty.");
        }

        var workDir = CreateWorkDirectory();
        try
        {
            var zipPath = Path.Combine(workDir, "upload.zip");
            await using (var stream = File.Create(zipPath))
            {
                await file.CopyToAsync(stream, cancellationToken);
            }

            ZipFile.ExtractToDirectory(zipPath, workDir);
            var shpPaths = Directory.GetFiles(workDir, "*.shp", SearchOption.AllDirectories);
            if (shpPaths.Length == 0)
            {
                throw new InvalidOperationException("The .zip must contain at least one .shp file.");
            }

            var imports = new List<ShapefileImport>();
            foreach (var shpPath in shpPaths)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var dbfPath = Path.ChangeExtension(shpPath, ".dbf");
                var shxPath = Path.ChangeExtension(shpPath, ".shx");
                if (!File.Exists(dbfPath) || !File.Exists(shxPath))
                {
                    throw new InvalidOperationException($"{Path.GetFileName(shpPath)} must include matching .shx and .dbf files.");
                }

                var features = Shapefile.ReadAllFeatures(shpPath)
                    .Select(feature => new SpatialFeature
                    {
                        Geometry = feature.Geometry,
                        Properties = feature.Attributes.GetNames()
                            .ToDictionary(name => name, name => NormalizeAttribute(feature.Attributes[name]))
                    })
                    .ToList();

                if (features.Count > MaxFeaturesPerShapefile)
                {
                    throw new InvalidOperationException(
                        $"{Path.GetFileName(shpPath)} has {features.Count} features. Upload shapefiles with {MaxFeaturesPerShapefile} features or fewer.");
                }

                if (features.Count > 0)
                {
                    imports.Add(new ShapefileImport(
                        Path.GetFileNameWithoutExtension(shpPath),
                        ReadProjectionWkt(shpPath),
                        features));
                }
            }

            return imports;
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    // Write the current database features into a shapefile and return it as a zipped byte array.
    public Task<byte[]> WriteZipAsync(string datasetName, string? projectionWkt, IReadOnlyList<SpatialFeature> features, CancellationToken cancellationToken)
    {
        if (features.Count == 0)
        {
            throw new InvalidOperationException("Cannot export an empty dataset.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        var workDir = CreateWorkDirectory();
        try
        {
            var safeName = SanitizeName(datasetName);
            var shpPath = Path.Combine(workDir, $"{safeName}.shp");
            var fieldMappings = BuildFieldMappings(features);
            var ntsFeatures = features.Select(feature =>
            {
                var attributes = new AttributesTable();
                foreach (var field in fieldMappings)
                {
                    feature.Properties.TryGetValue(field.SourceName, out var value);
                    attributes.Add(field.DbfName, NormalizeForDbf(value, field.Kind));
                }

                return new Feature(feature.Geometry, attributes);
            }).ToList();

            WriteAllFeaturesWithProjection(ntsFeatures, shpPath, projectionWkt);

            var zipPath = Path.Combine(workDir, $"{safeName}.zip");
            using (var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                foreach (var path in Directory.GetFiles(workDir, $"{safeName}.*"))
                {
                    if (Path.GetExtension(path).Equals(".zip", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    archive.CreateEntryFromFile(path, Path.GetFileName(path), CompressionLevel.Optimal);
                }
            }

            return Task.FromResult(File.ReadAllBytes(zipPath));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    // Read the original .prj text so downloads keep the same declared spatial reference.
    private static string? ReadProjectionWkt(string shpPath)
    {
        var prjPath = Path.ChangeExtension(shpPath, ".prj");
        if (!File.Exists(prjPath))
        {
            return null;
        }

        var projection = File.ReadAllText(prjPath, Encoding.Default).Trim();
        return string.IsNullOrWhiteSpace(projection) ? null : projection;
    }

    // Write shapefile parts first, then manually add a valid .prj with the exact base filename.
    private static void WriteAllFeaturesWithProjection(IReadOnlyList<Feature> features, string shpPath, string? projectionWkt)
    {
        Shapefile.WriteAllFeatures(features, shpPath);
        var projection = string.IsNullOrWhiteSpace(projectionWkt) ? Wgs84ProjectionWkt : projectionWkt.Trim();

        var prjPath = Path.ChangeExtension(shpPath, ".prj");
        File.WriteAllText(prjPath, projection, new UTF8Encoding(false));
    }

    // Create an isolated temporary folder for one import/export operation.
    private static string CreateWorkDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "gis-editing-app", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    // Convert DBF attribute values into JSON-safe values for PostgreSQL jsonb.
    private static object? NormalizeAttribute(object? value) => value switch
    {
        DBNull => null,
        DateTime date => date.ToString("yyyy-MM-dd"),
        _ => value
    };

    // Build one stable DBF schema for every feature so blank edited values do not change field types.
    private static IReadOnlyList<DbfFieldMapping> BuildFieldMappings(IReadOnlyList<SpatialFeature> features)
    {
        var sourceNames = features
            .SelectMany(feature => feature.Properties.Keys)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var usedDbfNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        return sourceNames
            .Select(sourceName =>
            {
                var dbfName = UniqueDbfFieldName(SanitizeFieldName(sourceName), usedDbfNames);
                var values = features.Select(feature =>
                    feature.Properties.TryGetValue(sourceName, out var value) ? value : null);
                return new DbfFieldMapping(sourceName, dbfName, InferDbfKind(values));
            })
            .ToList();
    }

    // Infer the least surprising DBF field type from non-empty values in the whole layer.
    private static DbfExportKind InferDbfKind(IEnumerable<object?> values)
    {
        var normalizedValues = values
            .Select(UnwrapJsonElement)
            .Where(value => value is not null && !IsBlankString(value))
            .Select(value => value!)
            .ToList();

        if (normalizedValues.Count == 0)
        {
            return DbfExportKind.Text;
        }

        if (normalizedValues.All(value => value is bool || IsBooleanString(value)))
        {
            return DbfExportKind.Boolean;
        }

        if (normalizedValues.All(value => value is DateTime || IsDateString(value)))
        {
            return DbfExportKind.Date;
        }

        if (normalizedValues.All(IsIntegerLike))
        {
            return DbfExportKind.Integer;
        }

        if (normalizedValues.All(IsNumberLike))
        {
            return DbfExportKind.Number;
        }

        return DbfExportKind.Text;
    }

    // Convert JSON values back into shapefile DBF-compatible scalar values for the inferred DBF type.
    private static object? NormalizeForDbf(object? value, DbfExportKind kind)
    {
        var normalized = UnwrapJsonElement(value);
        if (normalized is null || IsBlankString(normalized))
        {
            return kind == DbfExportKind.Text ? string.Empty : null;
        }

        return kind switch
        {
            DbfExportKind.Integer => ToIntOrNull(normalized),
            DbfExportKind.Number => ToDoubleOrNull(normalized),
            DbfExportKind.Boolean => ToBoolOrNull(normalized),
            DbfExportKind.Date => ToDateOrNull(normalized),
            _ => normalized.ToString() ?? string.Empty
        };
    }

    // Pull primitive CLR values out of jsonb values loaded through System.Text.Json.
    private static object? UnwrapJsonElement(object? value)
    {
        if (value is not System.Text.Json.JsonElement element)
        {
            return value;
        }

        return element.ValueKind switch
        {
            System.Text.Json.JsonValueKind.Number when element.TryGetInt32(out var intValue) => intValue,
            System.Text.Json.JsonValueKind.Number when element.TryGetInt64(out var longValue) => longValue,
            System.Text.Json.JsonValueKind.Number when element.TryGetDouble(out var doubleValue) => doubleValue,
            System.Text.Json.JsonValueKind.True => true,
            System.Text.Json.JsonValueKind.False => false,
            System.Text.Json.JsonValueKind.String => element.GetString(),
            System.Text.Json.JsonValueKind.Null => null,
            _ => element.ToString()
        };
    }

    // Remove characters that are invalid in a generated shapefile name.
    private static string SanitizeName(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(value.Select(character => invalid.Contains(character) ? '_' : character).ToArray()).Trim();
        return string.IsNullOrWhiteSpace(clean) ? "dataset" : clean;
    }

    // Keep DBF field names valid and short enough for shapefile constraints.
    private static string SanitizeFieldName(string value)
    {
        var clean = new string(value.Where(char.IsLetterOrDigit).Take(10).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "field" : clean;
    }

    // Avoid collisions after DBF's ten-character field-name limit truncates similar names.
    private static string UniqueDbfFieldName(string baseName, HashSet<string> usedNames)
    {
        var candidate = baseName[..Math.Min(baseName.Length, 10)];
        var suffix = 1;
        while (!usedNames.Add(candidate))
        {
            var suffixText = suffix.ToString(CultureInfo.InvariantCulture);
            var prefixLength = Math.Max(1, 10 - suffixText.Length);
            candidate = $"{baseName[..Math.Min(baseName.Length, prefixLength)]}{suffixText}";
            suffix++;
        }

        return candidate;
    }

    private static bool IsBlankString(object value) =>
        value is string text && string.IsNullOrWhiteSpace(text);

    private static bool IsBooleanString(object value) =>
        value is string text && bool.TryParse(text, out _);

    private static bool IsDateString(object value) =>
        value is string text && DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    private static bool IsIntegerLike(object value) =>
        value is byte or short or int or long
        || (value is string text && int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _));

    private static bool IsNumberLike(object value) =>
        value is byte or short or int or long or float or double or decimal
        || (value is string text && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out _));

    private static int? ToIntOrNull(object value) =>
        value switch
        {
            int intValue => intValue,
            long longValue when longValue <= int.MaxValue && longValue >= int.MinValue => (int)longValue,
            double doubleValue => Convert.ToInt32(doubleValue),
            string text when int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var intValue) => intValue,
            _ => null
        };

    private static double? ToDoubleOrNull(object value) =>
        value switch
        {
            double doubleValue => doubleValue,
            float floatValue => floatValue,
            decimal decimalValue => (double)decimalValue,
            int intValue => intValue,
            long longValue => longValue,
            string text when double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var doubleValue) => doubleValue,
            _ => null
        };

    private static bool? ToBoolOrNull(object value) =>
        value switch
        {
            bool boolValue => boolValue,
            string text when bool.TryParse(text, out var boolValue) => boolValue,
            _ => null
        };

    private static DateTime? ToDateOrNull(object value) =>
        value switch
        {
            DateTime dateValue => dateValue,
            string text when DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dateValue) => dateValue,
            _ => null
        };

    // Best-effort cleanup for temporary shapefile import/export folders.
    private static void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, true);
            }
        }
        catch
        {
            // Temporary import/export files can be cleaned by the OS if a handle is still settling.
        }
    }
}
