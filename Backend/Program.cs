using Api.Data;
using Api.Services;
using Microsoft.EntityFrameworkCore;
using NetTopologySuite.IO.Converters;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
        policy.WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:5173"])
            .AllowAnyHeader()
            .AllowAnyMethod());
});

builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.Converters.Add(new GeoJsonConverterFactory());
    });

builder.Services.AddDbContext<EditingDbContext>(options =>
{
    var connectionString = builder.Configuration.GetConnectionString("Postgres")
        ?? "Host=localhost;Port=5432;Database=gis_editing_app;Username=postgres;Password=postgres";
    options.UseNpgsql(connectionString, npgsql => npgsql.UseNetTopologySuite());
});

builder.Services.AddScoped<IShapefileService, ShapefileService>();
builder.Services.AddEndpointsApiExplorer();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<EditingDbContext>();
    await db.Database.EnsureCreatedAsync();
    await EnsureSessionColumnsAsync(db);
}

app.UseCors("Frontend");
app.UseHttpsRedirection();
app.MapGet("/", () => Results.Ok(new
{
    name = "GIS Editing App API",
    status = "running",
    datasets = "/api/datasets",
    frontend = "https://geoediting.netlify.app/"
}));
app.MapControllers();
app.Run();

// Add session columns to older local databases that were created before session isolation existed.
static async Task EnsureSessionColumnsAsync(EditingDbContext db)
{
    await db.Database.ExecuteSqlRawAsync(
        """
        ALTER TABLE datasets ADD COLUMN IF NOT EXISTS "SessionId" text NOT NULL DEFAULT 'default-session';
        ALTER TABLE datasets ADD COLUMN IF NOT EXISTS "ProjectionWkt" text NULL;
        ALTER TABLE datasets ADD COLUMN IF NOT EXISTS "SourceFormat" character varying(20) NOT NULL DEFAULT 'shp';
        ALTER TABLE features ADD COLUMN IF NOT EXISTS "SessionId" text NOT NULL DEFAULT 'default-session';
        CREATE INDEX IF NOT EXISTS "IX_datasets_SessionId" ON datasets ("SessionId");
        CREATE INDEX IF NOT EXISTS "IX_features_SessionId_DatasetId" ON features ("SessionId", "DatasetId");
        """);
}
