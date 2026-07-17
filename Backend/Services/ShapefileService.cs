using Api.Models;
using NetTopologySuite;
using NetTopologySuite.Features;
using NetTopologySuite.Geometries;
using NetTopologySuite.IO.Converters;
using NetTopologySuite.IO.Esri;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;

namespace Api.Services;

public sealed class ShapefileService : IShapefileService
{
    private const int MaxFeaturesPerDataset = 1000;
    private const string Wgs84ProjectionWkt =
        "GEOGCS[\"GCS_WGS_1984\",DATUM[\"D_WGS_1984\",SPHEROID[\"WGS_1984\",6378137.0,298.257223563]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]]";
    private static readonly GeometryFactory Wgs84GeometryFactory = NtsGeometryServices.Instance.CreateGeometryFactory(srid: 4326);
    private static readonly JsonSerializerOptions GeoJsonOptions = CreateGeoJsonOptions();
    private enum DbfExportKind { Text, Integer, Number, Boolean, Date }
    private sealed record DbfFieldMapping(string SourceName, string DbfName, DbfExportKind Kind);

    // Route uploaded vector files by extension while preserving the original export format.
    public async Task<IReadOnlyList<ShapefileImport>> ReadAsync(IFormFile file, CancellationToken cancellationToken)
    {
        if (file.Length == 0)
        {
            throw new InvalidOperationException("Uploaded file is empty.");
        }

        var extension = Path.GetExtension(file.FileName).ToLowerInvariant();
        return extension switch
        {
            ".zip" => await ReadShapefileZipAsync(file, cancellationToken),
            ".geojson" or ".json" => await ReadGeoJsonAsync(file, "geojson", cancellationToken),
            ".kml" => await ReadKmlAsync(file, "kml", cancellationToken),
            ".kmz" => await ReadKmzAsync(file, cancellationToken),
            _ => throw new InvalidOperationException("Upload a zipped shapefile, GeoJSON, KML, or KMZ file.")
        };
    }

    // Export the edited dataset back to the same vector format that the user uploaded.
    public Task<ExportResult> WriteAsync(
        string datasetName,
        string? projectionWkt,
        string sourceFormat,
        IReadOnlyList<SpatialFeature> features,
        CancellationToken cancellationToken)
    {
        if (features.Count == 0)
        {
            throw new InvalidOperationException("Cannot export an empty dataset.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        var format = sourceFormat.ToLowerInvariant();
        return format switch
        {
            "geojson" => Task.FromResult(WriteGeoJson(datasetName, features)),
            "kml" => Task.FromResult(WriteKml(datasetName, features)),
            "kmz" => Task.FromResult(WriteKmz(datasetName, features)),
            _ => Task.FromResult(WriteShapefileZip(datasetName, projectionWkt, features))
        };
    }

    // Extract one uploaded ZIP and import every complete .shp/.shx/.dbf shapefile set inside it.
    private static async Task<IReadOnlyList<ShapefileImport>> ReadShapefileZipAsync(IFormFile file, CancellationToken cancellationToken)
    {
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
                        Geometry = NormalizeGeometry(feature.Geometry),
                        Properties = feature.Attributes.GetNames()
                            .ToDictionary(name => name, name => NormalizeAttribute(feature.Attributes[name]))
                    })
                    .ToList();

                ValidateFeatureCount(Path.GetFileName(shpPath), features.Count);

                if (features.Count > 0)
                {
                    imports.Add(new ShapefileImport(
                        Path.GetFileNameWithoutExtension(shpPath),
                        ReadProjectionWkt(shpPath),
                        "shp",
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

    // Read a GeoJSON FeatureCollection as one editable dataset.
    private static async Task<IReadOnlyList<ShapefileImport>> ReadGeoJsonAsync(IFormFile file, string sourceFormat, CancellationToken cancellationToken)
    {
        await using var stream = file.OpenReadStream();
        var featureCollection = await JsonSerializer.DeserializeAsync<FeatureCollection>(stream, GeoJsonOptions, cancellationToken)
            ?? new FeatureCollection();
        var features = featureCollection
            .Where(feature => feature.Geometry is not null)
            .Select(feature => new SpatialFeature
            {
                Geometry = NormalizeGeometry(feature.Geometry),
                Properties = ToDictionary(feature.Attributes)
            })
            .ToList();

        ValidateFeatureCount(file.FileName, features.Count);
        return features.Count == 0
            ? []
            : [new ShapefileImport(Path.GetFileNameWithoutExtension(file.FileName), Wgs84ProjectionWkt, sourceFormat, features)];
    }

    // Read one KML document as one editable dataset.
    private static async Task<IReadOnlyList<ShapefileImport>> ReadKmlAsync(IFormFile file, string sourceFormat, CancellationToken cancellationToken)
    {
        await using var stream = file.OpenReadStream();
        var document = await XDocument.LoadAsync(stream, LoadOptions.None, cancellationToken);
        var features = ReadKmlFeatures(document).ToList();
        ValidateFeatureCount(file.FileName, features.Count);
        return features.Count == 0
            ? []
            : [new ShapefileImport(Path.GetFileNameWithoutExtension(file.FileName), Wgs84ProjectionWkt, sourceFormat, features)];
    }

    // Read the KML files inside a KMZ and keep KMZ as the export format.
    private static async Task<IReadOnlyList<ShapefileImport>> ReadKmzAsync(IFormFile file, CancellationToken cancellationToken)
    {
        var workDir = CreateWorkDirectory();
        try
        {
            var kmzPath = Path.Combine(workDir, "upload.kmz");
            await using (var stream = File.Create(kmzPath))
            {
                await file.CopyToAsync(stream, cancellationToken);
            }

            ZipFile.ExtractToDirectory(kmzPath, workDir);
            var kmlPaths = Directory.GetFiles(workDir, "*.kml", SearchOption.AllDirectories);
            if (kmlPaths.Length == 0)
            {
                throw new InvalidOperationException("The .kmz must contain at least one .kml file.");
            }

            var imports = new List<ShapefileImport>();
            foreach (var kmlPath in kmlPaths)
            {
                await using var stream = File.OpenRead(kmlPath);
                var document = await XDocument.LoadAsync(stream, LoadOptions.None, cancellationToken);
                var features = ReadKmlFeatures(document).ToList();
                ValidateFeatureCount(Path.GetFileName(kmlPath), features.Count);
                if (features.Count > 0)
                {
                    imports.Add(new ShapefileImport(Path.GetFileNameWithoutExtension(kmlPath), Wgs84ProjectionWkt, "kmz", features));
                }
            }

            return imports;
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    // Write the current database features into a shapefile ZIP.
    private static ExportResult WriteShapefileZip(string datasetName, string? projectionWkt, IReadOnlyList<SpatialFeature> features)
    {
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
                    if (!Path.GetExtension(path).Equals(".zip", StringComparison.OrdinalIgnoreCase))
                    {
                        archive.CreateEntryFromFile(path, Path.GetFileName(path), CompressionLevel.Optimal);
                    }
                }
            }

            return new ExportResult(File.ReadAllBytes(zipPath), "application/zip", $"{safeName}-edited.zip");
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    // Write edited features as a GeoJSON FeatureCollection.
    private static ExportResult WriteGeoJson(string datasetName, IReadOnlyList<SpatialFeature> features)
    {
        var collection = new FeatureCollection();
        foreach (var spatialFeature in features)
        {
            collection.Add(new Feature(spatialFeature.Geometry, ToAttributesTable(spatialFeature.Properties)));
        }

        var json = JsonSerializer.Serialize(collection, GeoJsonOptions);
        return new ExportResult(Encoding.UTF8.GetBytes(json), "application/geo+json", $"{SanitizeName(datasetName)}-edited.geojson");
    }

    // Write edited features as plain KML.
    private static ExportResult WriteKml(string datasetName, IReadOnlyList<SpatialFeature> features)
    {
        var bytes = Encoding.UTF8.GetBytes(BuildKmlDocument(datasetName, features).ToString(SaveOptions.DisableFormatting));
        return new ExportResult(bytes, "application/vnd.google-earth.kml+xml", $"{SanitizeName(datasetName)}-edited.kml");
    }

    // Write edited features as KMZ, a zip containing doc.kml.
    private static ExportResult WriteKmz(string datasetName, IReadOnlyList<SpatialFeature> features)
    {
        var workDir = CreateWorkDirectory();
        try
        {
            var safeName = SanitizeName(datasetName);
            var kmlPath = Path.Combine(workDir, "doc.kml");
            File.WriteAllText(kmlPath, BuildKmlDocument(datasetName, features).ToString(SaveOptions.DisableFormatting), new UTF8Encoding(false));
            var kmzPath = Path.Combine(workDir, $"{safeName}.kmz");
            using (var archive = ZipFile.Open(kmzPath, ZipArchiveMode.Create))
            {
                archive.CreateEntryFromFile(kmlPath, "doc.kml", CompressionLevel.Optimal);
            }

            return new ExportResult(File.ReadAllBytes(kmzPath), "application/vnd.google-earth.kmz", $"{safeName}-edited.kmz");
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    // Read the original .prj text so shapefile downloads keep the same declared spatial reference.
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

    // Keep large user uploads from freezing the browser editor.
    private static void ValidateFeatureCount(string fileName, int count)
    {
        if (count > MaxFeaturesPerDataset)
        {
            throw new InvalidOperationException(
                $"{fileName} has {count} features. Upload vector layers with {MaxFeaturesPerDataset} features or fewer.");
        }
    }

    // Normalize SRID for browser and KML/GeoJSON editing.
    private static Geometry NormalizeGeometry(Geometry geometry)
    {
        if (geometry.SRID <= 0)
        {
            geometry.SRID = 4326;
        }

        return geometry;
    }

    // Convert DBF/KML/GeoJSON attribute values into JSON-safe values for PostgreSQL jsonb.
    private static object? NormalizeAttribute(object? value) => value switch
    {
        DBNull => null,
        DateTime date => date.ToString("yyyy-MM-dd"),
        JsonElement element => UnwrapJsonElement(element),
        _ => value
    };

    // Parse KML placemarks into spatial features.
    private static IEnumerable<SpatialFeature> ReadKmlFeatures(XDocument document)
    {
        foreach (var placemark in document.Descendants().Where(element => element.Name.LocalName == "Placemark"))
        {
            var geometry = ReadKmlGeometry(placemark);
            if (geometry is null) continue;

            var properties = ReadKmlProperties(placemark);
            yield return new SpatialFeature
            {
                Geometry = NormalizeGeometry(geometry),
                Properties = properties
            };
        }
    }

    // KML geometries are nested by element name rather than a single geometry JSON object.
    private static Geometry? ReadKmlGeometry(XElement placemark)
    {
        var geometryElement = placemark.Elements().FirstOrDefault(IsKmlGeometryElement)
            ?? placemark.Descendants().FirstOrDefault(IsKmlGeometryElement);
        return geometryElement is null ? null : ReadKmlGeometryElement(geometryElement);
    }

    private static Geometry? ReadKmlGeometryElement(XElement element) =>
        element.Name.LocalName switch
        {
            "Point" => ReadPoint(element),
            "LineString" => ReadLineString(element),
            "Polygon" => ReadPolygon(element),
            "MultiGeometry" => ReadMultiGeometry(element),
            _ => null
        };

    private static bool IsKmlGeometryElement(XElement element) =>
        element.Name.LocalName is "Point" or "LineString" or "Polygon" or "MultiGeometry";

    private static Point? ReadPoint(XElement element)
    {
        var coordinates = ReadCoordinates(element).ToList();
        return coordinates.Count == 0 ? null : Wgs84GeometryFactory.CreatePoint(coordinates[0]);
    }

    private static LineString? ReadLineString(XElement element)
    {
        var coordinates = ReadCoordinates(element).ToArray();
        return coordinates.Length < 2 ? null : Wgs84GeometryFactory.CreateLineString(coordinates);
    }

    private static Polygon? ReadPolygon(XElement element)
    {
        var outer = element.Descendants().FirstOrDefault(item => item.Name.LocalName == "outerBoundaryIs");
        var shellCoordinates = outer is null ? [] : ReadCoordinates(outer).ToArray();
        if (shellCoordinates.Length < 4) return null;

        var shell = Wgs84GeometryFactory.CreateLinearRing(CloseRing(shellCoordinates));
        var holes = element.Descendants()
            .Where(item => item.Name.LocalName == "innerBoundaryIs")
            .Select(item => ReadCoordinates(item).ToArray())
            .Where(coordinates => coordinates.Length >= 4)
            .Select(coordinates => Wgs84GeometryFactory.CreateLinearRing(CloseRing(coordinates)))
            .ToArray();
        return Wgs84GeometryFactory.CreatePolygon(shell, holes);
    }

    private static Geometry? ReadMultiGeometry(XElement element)
    {
        var geometries = element.Elements()
            .Select(ReadKmlGeometryElement)
            .Where(geometry => geometry is not null)
            .Select(geometry => geometry!)
            .ToArray();
        if (geometries.Length == 0) return null;
        if (geometries.All(geometry => geometry is Point))
        {
            return Wgs84GeometryFactory.CreateMultiPoint(geometries.Cast<Point>().ToArray());
        }
        if (geometries.All(geometry => geometry is LineString))
        {
            return Wgs84GeometryFactory.CreateMultiLineString(geometries.Cast<LineString>().ToArray());
        }
        if (geometries.All(geometry => geometry is Polygon))
        {
            return Wgs84GeometryFactory.CreateMultiPolygon(geometries.Cast<Polygon>().ToArray());
        }

        return Wgs84GeometryFactory.CreateGeometryCollection(geometries);
    }

    private static IEnumerable<Coordinate> ReadCoordinates(XElement element)
    {
        var text = element.Descendants().FirstOrDefault(item => item.Name.LocalName == "coordinates")?.Value ?? string.Empty;
        foreach (var tuple in text.Split([' ', '\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = tuple.Split(',', StringSplitOptions.TrimEntries);
            if (parts.Length < 2) continue;
            if (double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var longitude)
                && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var latitude))
            {
                yield return new Coordinate(longitude, latitude);
            }
        }
    }

    private static Coordinate[] CloseRing(Coordinate[] coordinates)
    {
        if (coordinates.Length == 0 || coordinates[0].Equals2D(coordinates[^1]))
        {
            return coordinates;
        }

        return [.. coordinates, coordinates[0]];
    }

    private static Dictionary<string, object?> ReadKmlProperties(XElement placemark)
    {
        var properties = new Dictionary<string, object?>();
        var name = placemark.Elements().FirstOrDefault(element => element.Name.LocalName == "name")?.Value;
        if (!string.IsNullOrWhiteSpace(name)) properties["name"] = name.Trim();
        var description = placemark.Elements().FirstOrDefault(element => element.Name.LocalName == "description")?.Value;
        if (!string.IsNullOrWhiteSpace(description)) properties["description"] = description.Trim();

        foreach (var data in placemark.Descendants().Where(element => element.Name.LocalName == "Data"))
        {
            var key = data.Attribute("name")?.Value;
            if (string.IsNullOrWhiteSpace(key)) continue;
            var value = data.Elements().FirstOrDefault(element => element.Name.LocalName == "value")?.Value;
            properties[key] = value;
        }

        return properties;
    }

    // Build a compact KML document from edited features.
    private static XDocument BuildKmlDocument(string datasetName, IReadOnlyList<SpatialFeature> features)
    {
        XNamespace kml = "http://www.opengis.net/kml/2.2";
        return new XDocument(
            new XDeclaration("1.0", "UTF-8", null),
            new XElement(kml + "kml",
                new XElement(kml + "Document",
                    new XElement(kml + "name", datasetName),
                    features.Select((feature, index) =>
                        new XElement(kml + "Placemark",
                            new XElement(kml + "name", FeatureName(feature, index)),
                            BuildExtendedData(kml, feature.Properties),
                            BuildKmlGeometry(kml, feature.Geometry))))));
    }

    private static string FeatureName(SpatialFeature feature, int index)
    {
        if (feature.Properties.TryGetValue("name", out var name) && !IsBlankString(name ?? string.Empty))
        {
            return name?.ToString() ?? $"Feature {index + 1}";
        }

        return $"Feature {index + 1}";
    }

    private static XElement BuildExtendedData(XNamespace kml, Dictionary<string, object?> properties) =>
        new(kml + "ExtendedData",
            properties.Select(property =>
                new XElement(kml + "Data",
                    new XAttribute("name", property.Key),
                    new XElement(kml + "value", UnwrapJsonElement(property.Value)?.ToString() ?? string.Empty))));

    private static XElement BuildKmlGeometry(XNamespace kml, Geometry geometry) =>
        geometry switch
        {
            Point point => new XElement(kml + "Point", new XElement(kml + "coordinates", FormatCoordinate(point.Coordinate))),
            LineString line => new XElement(kml + "LineString", new XElement(kml + "coordinates", FormatCoordinates(line.Coordinates))),
            Polygon polygon => BuildKmlPolygon(kml, polygon),
            MultiPoint multiPoint => new XElement(kml + "MultiGeometry", multiPoint.Geometries.Select(geometry => BuildKmlGeometry(kml, geometry))),
            MultiLineString multiLine => new XElement(kml + "MultiGeometry", multiLine.Geometries.Select(geometry => BuildKmlGeometry(kml, geometry))),
            MultiPolygon multiPolygon => new XElement(kml + "MultiGeometry", multiPolygon.Geometries.Select(geometry => BuildKmlGeometry(kml, geometry))),
            GeometryCollection collection => new XElement(kml + "MultiGeometry", collection.Geometries.Select(geometry => BuildKmlGeometry(kml, geometry))),
            _ => new XElement(kml + "Point", new XElement(kml + "coordinates", "0,0"))
        };

    private static XElement BuildKmlPolygon(XNamespace kml, Polygon polygon) =>
        new(kml + "Polygon",
            new XElement(kml + "outerBoundaryIs",
                new XElement(kml + "LinearRing",
                    new XElement(kml + "coordinates", FormatCoordinates(polygon.ExteriorRing.Coordinates)))),
            Enumerable.Range(0, polygon.NumInteriorRings)
                .Select(index => new XElement(kml + "innerBoundaryIs",
                    new XElement(kml + "LinearRing",
                        new XElement(kml + "coordinates", FormatCoordinates(polygon.GetInteriorRingN(index).Coordinates))))));

    private static string FormatCoordinates(IEnumerable<Coordinate> coordinates) =>
        string.Join(" ", coordinates.Select(FormatCoordinate));

    private static string FormatCoordinate(Coordinate coordinate) =>
        string.Create(CultureInfo.InvariantCulture, $"{coordinate.X},{coordinate.Y}");

    // Convert NTS attributes into a JSON-safe dictionary.
    private static Dictionary<string, object?> ToDictionary(IAttributesTable attributes)
    {
        var dictionary = new Dictionary<string, object?>();
        foreach (var name in attributes.GetNames())
        {
            dictionary[name] = NormalizeAttribute(attributes[name]);
        }

        return dictionary;
    }

    private static AttributesTable ToAttributesTable(Dictionary<string, object?> properties)
    {
        var attributes = new AttributesTable();
        foreach (var (key, value) in properties)
        {
            attributes.Add(key, UnwrapJsonElement(value));
        }

        return attributes;
    }

    private static JsonSerializerOptions CreateGeoJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new GeoJsonConverterFactory());
        return options;
    }

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
        if (value is not JsonElement element)
        {
            return value;
        }

        return element.ValueKind switch
        {
            JsonValueKind.Number when element.TryGetInt32(out var intValue) => intValue,
            JsonValueKind.Number when element.TryGetInt64(out var longValue) => longValue,
            JsonValueKind.Number when element.TryGetDouble(out var doubleValue) => doubleValue,
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Null => null,
            _ => element.ToString()
        };
    }

    // Remove characters that are invalid in generated download names.
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

    // Best-effort cleanup for temporary vector import/export folders.
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
