using Aspire.Hosting;
using Aspire.Hosting.JavaScript;

var builder = DistributedApplication.CreateBuilder(args);

// Host ports; override via NABBIT_*_PORT env vars to run beside other projects that hold the defaults.
static int Port(string name, int fallback) =>
    int.TryParse(Environment.GetEnvironmentVariable(name), out var p) && p is > 0 and < 65536 ? p : fallback;

var backendPort = Port("NABBIT_BACKEND_PORT", 3000);
var localstackPort = Port("NABBIT_LOCALSTACK_PORT", 4566);
var cognitoPort = Port("NABBIT_COGNITO_PORT", 9229);
var mailhogUiPort = Port("NABBIT_MAILHOG_UI_PORT", 8025);
var mailhogSmtpPort = Port("NABBIT_MAILHOG_SMTP_PORT", 1025);
var frontendPort = Port("NABBIT_FRONTEND_PORT", 5173);
var localstackUrl = $"http://localhost:{localstackPort}";
// Plain strings: interpolating ints inside WithEnvironment binds to Aspire's ReferenceExpression handler.
var cognitoUrl = $"http://localhost:{cognitoPort}";
var frontendUrl = $"http://localhost:{frontendPort}";
var backendUrl = $"http://localhost:{backendPort}";

const string table = "nabbit-local-data";
const string bucket = "nabbit-local-images";

// Pin LocalStack to v3 (newer tags require account auth).
var localstack = builder.AddContainer("localstack", "localstack/localstack", "3")
    .WithEnvironment("SERVICES", "s3,dynamodb")
    .WithEnvironment("LOCALSTACK_ACKNOWLEDGE_ACCOUNT_REQUIREMENT", "1")
    .WithHttpEndpoint(port: localstackPort, targetPort: 4566, name: "localstack")
    .WithHttpHealthCheck("/_localstack/health", endpointName: "localstack");

var cognitoLocal = builder.AddContainer("cognito-local", "jagregory/cognito-local", "latest")
    .WithHttpEndpoint(port: cognitoPort, targetPort: 9229, name: "cognito-local")
    .WithBindMount("../cognito-local-data", "/app/.cognito");

builder.AddContainer("mailhog", "mailhog/mailhog", "latest")
    .WithHttpEndpoint(port: mailhogUiPort, targetPort: 8025, name: "mailhog-ui")
    .WithEndpoint(port: mailhogSmtpPort, targetPort: 1025, name: "mailhog-smtp");

// Creates the table (same key schema as the CDK table) and image bucket, then exits.
var initDb = builder.AddJavaScriptApp("init-db", "../../backend", "init-local")
    .WaitFor(localstack)
    .WithEnvironment("AWS_ENDPOINT_URL", localstackUrl)
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
    .WithEnvironment("AWS_ENDPOINT_URL", localstackUrl)
    .WithEnvironment("TABLE_NAME", table)
    .WithEnvironment("IMAGE_BUCKET", bucket)
    .WithEnvironment("IMAGE_BASE_URL", localstackUrl + "/" + bucket)
    .WithEnvironment("USER_POOL_ID", "local_abc123")
    .WithEnvironment("USER_POOL_CLIENT_ID", "local-client-id")
    .WithEnvironment("COGNITO_ENDPOINT", cognitoUrl)
    .WithEnvironment("ALLOWED_ORIGIN", frontendUrl)
    // The API suite must never reach instagram.com: request 07 expects needs_text, which only holds with auto-fetch off.
    .WithEnvironment("INSTAGRAM_AUTOFETCH", "0")
    .WithHttpEndpoint(port: backendPort, env: "PORT")
    .WithExternalHttpEndpoints();

// The Angular frontend arrives in a later ticket; wire it in once it has a package.json.
if (File.Exists(Path.Combine(builder.AppHostDirectory, "..", "..", "frontend", "package.json")))
{
    builder.AddJavaScriptApp("frontend", "../../frontend", "start")
        .WithEnvironment("NODE_ENV", "development")
        .WithEnvironment("NG_APP_API_BASE_URL", backendUrl)
        .WithHttpEndpoint(port: frontendPort, env: "PORT")
        .WithExternalHttpEndpoints();
}

builder.Build().Run();
