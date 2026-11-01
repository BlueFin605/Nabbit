using Aspire.Hosting;
using Aspire.Hosting.JavaScript;

var builder = DistributedApplication.CreateBuilder(args);

const string table = "nabbit-local-data";
const string bucket = "nabbit-local-images";

// Pin LocalStack to v3 (newer tags require account auth).
var localstack = builder.AddContainer("localstack", "localstack/localstack", "3")
    .WithEnvironment("SERVICES", "s3,dynamodb")
    .WithEnvironment("LOCALSTACK_ACKNOWLEDGE_ACCOUNT_REQUIREMENT", "1")
    .WithHttpEndpoint(port: 4566, targetPort: 4566, name: "localstack")
    .WithHttpHealthCheck("/_localstack/health", endpointName: "localstack");

var cognitoLocal = builder.AddContainer("cognito-local", "jagregory/cognito-local", "latest")
    .WithHttpEndpoint(port: 9229, targetPort: 9229, name: "cognito-local")
    .WithBindMount("../cognito-local-data", "/app/.cognito");

builder.AddContainer("mailhog", "mailhog/mailhog", "latest")
    .WithHttpEndpoint(port: 8025, targetPort: 8025, name: "mailhog-ui")
    .WithEndpoint(port: 1025, targetPort: 1025, name: "mailhog-smtp");

// Creates the table (same key schema as the CDK table) and image bucket, then exits.
var initDb = builder.AddJavaScriptApp("init-db", "../../backend", "init-local")
    .WaitFor(localstack)
    .WithEnvironment("AWS_ENDPOINT_URL", "http://localhost:4566")
    .WithEnvironment("TABLE_NAME", table)
    .WithEnvironment("IMAGE_BUCKET", bucket);

// Express wrapper around the Lambda handlers; env vars mirror the CDK Lambda contract.
builder.AddJavaScriptApp("backend", "../../backend", "dev")
    .WaitFor(initDb)
    .WaitFor(cognitoLocal)
    .WithEnvironment("NODE_ENV", "development")
    .WithEnvironment("AWS_REGION", "us-east-1")
    .WithEnvironment("AWS_ACCESS_KEY_ID", "test")
    .WithEnvironment("AWS_SECRET_ACCESS_KEY", "test")
    .WithEnvironment("AWS_ENDPOINT_URL", "http://localhost:4566")
    .WithEnvironment("TABLE_NAME", table)
    .WithEnvironment("IMAGE_BUCKET", bucket)
    .WithEnvironment("IMAGE_BASE_URL", "http://localhost:4566/" + bucket)
    .WithEnvironment("USER_POOL_ID", "local_abc123")
    .WithEnvironment("USER_POOL_CLIENT_ID", "local-client-id")
    .WithEnvironment("COGNITO_ENDPOINT", "http://localhost:9229")
    .WithEnvironment("ALLOWED_ORIGIN", "http://localhost:5173")
    .WithHttpEndpoint(port: 3000, env: "PORT")
    .WithExternalHttpEndpoints();

// The Angular frontend arrives in a later ticket; wire it in once it has a package.json.
if (File.Exists(Path.Combine(builder.AppHostDirectory, "..", "..", "frontend", "package.json")))
{
    builder.AddJavaScriptApp("frontend", "../../frontend", "start")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("NG_APP_API_BASE_URL", "http://localhost:3000")
        .WithHttpEndpoint(port: 5173, env: "PORT")
        .WithExternalHttpEndpoints();
}

builder.Build().Run();
