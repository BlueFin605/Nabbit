using Amazon.CDK;
using Amazon.CDK.AwsApigatewayv2Authorizers;
using Amazon.CDK.AwsApigatewayv2Integrations;
using Amazon.CDK.AWS.CertificateManager;
using Amazon.CDK.AWS.CloudFront;
using Amazon.CDK.AWS.CloudFront.Origins;
using Amazon.CDK.AWS.Cognito;
using Amazon.CDK.AWS.DynamoDB;
using Amazon.CDK.AWS.Lambda;
using Amazon.CDK.AWS.Logs;
using Distribution = Amazon.CDK.AWS.CloudFront.Distribution;
using Amazon.CDK.AWS.Route53;
using Amazon.CDK.AWS.Route53.Targets;
using Amazon.CDK.AWS.S3;
using Constructs;
using Apigw = Amazon.CDK.AWS.Apigatewayv2;

namespace Infrastructure.Stacks
{
    /// <summary>The whole Nabbit backend and hosting in one stack. See infrastructure/SYSDOC.md.</summary>
    public class NabbitStack : Stack
    {
        public Table DataTable { get; }
        public UserPool UserPool { get; }
        public UserPoolClient UserPoolClient { get; }
        public Bucket ImageBucket { get; }
        public Bucket SpaBucket { get; }
        public Distribution Distribution { get; }
        public Apigw.HttpApi Api { get; }
        public Amazon.CDK.AWS.Lambda.Function ApiFunction { get; }
        public Amazon.CDK.AWS.Lambda.Function ImportFunction { get; }

        /// <summary>Reserved concurrency applied to the import function.</summary>
        public int ImportReservedConcurrency { get; }

        public NabbitStack(Construct scope, string id, IStackProps props, NabbitConfig config, ICertificate globalCert) : base(scope, id, props)
        {
            ImportReservedConcurrency = config.ImportReservedConcurrency;
            var origin = $"https://{config.Domain}";
            var zone = config.ResolveZone(this, "Zone");

            // ---- Data ----
            DataTable = new Table(this, "DataTable", new TableProps
            {
                TableName = config.Name("data"),
                PartitionKey = new Amazon.CDK.AWS.DynamoDB.Attribute { Name = "pk", Type = AttributeType.STRING },
                SortKey = new Amazon.CDK.AWS.DynamoDB.Attribute { Name = "sk", Type = AttributeType.STRING },
                BillingMode = BillingMode.PAY_PER_REQUEST,
                TimeToLiveAttribute = "ttl",
                PointInTimeRecoverySpecification = new PointInTimeRecoverySpecification { PointInTimeRecoveryEnabled = true },
                RemovalPolicy = RemovalPolicy.RETAIN,
            });

            // ---- Auth ----
            UserPool = new UserPool(this, "UserPool", new UserPoolProps
            {
                UserPoolName = config.Name("users"),
                SelfSignUpEnabled = true,
                SignInAliases = new SignInAliases { Email = true },
                AutoVerify = new AutoVerifiedAttrs { Email = true },
                UserVerification = new UserVerificationConfig { EmailStyle = VerificationEmailStyle.CODE },
                AccountRecovery = AccountRecovery.EMAIL_ONLY,
                PasswordPolicy = new PasswordPolicy
                {
                    MinLength = 12,
                    RequireLowercase = true,
                    RequireUppercase = true,
                    RequireDigits = true,
                    RequireSymbols = false,
                },
                RemovalPolicy = RemovalPolicy.RETAIN,
            });

            UserPoolClient = UserPool.AddClient("WebClient", new UserPoolClientOptions
            {
                UserPoolClientName = config.Name("web"),
                GenerateSecret = false,
                PreventUserExistenceErrors = true,
                OAuth = new OAuthSettings
                {
                    Flows = new OAuthFlows { AuthorizationCodeGrant = true },
                    Scopes = new[] { OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE },
                    CallbackUrls = new[] { $"{origin}/", $"{origin}/auth/callback" },
                    LogoutUrls = new[] { $"{origin}/" },
                },
                SupportedIdentityProviders = new[] { UserPoolClientIdentityProvider.COGNITO },
            });

            // ---- Storage ----
            // Browser uploads directly via presigned POST from the SPA origin; reads go through CloudFront, so POST only.
            ImageBucket = PrivateBucket("ImageBucket", config.Name("images"), new[]
            {
                new CorsRule
                {
                    AllowedOrigins = new[] { origin },
                    AllowedMethods = new[] { HttpMethods.POST },
                    AllowedHeaders = new[] { "*" },
                    MaxAge = 3000,
                },
            });
            SpaBucket = PrivateBucket("SpaBucket", config.Name("spa"));

            // ---- API ----
            var apiLogs = new LogGroup(this, "ApiLogs", new LogGroupProps
            {
                LogGroupName = $"/aws/lambda/{config.Name("api")}",
                Retention = RetentionDays.ONE_MONTH,
                RemovalPolicy = RemovalPolicy.DESTROY,
            });

            ApiFunction = new Amazon.CDK.AWS.Lambda.Function(this, "ApiFunction", new Amazon.CDK.AWS.Lambda.FunctionProps
            {
                FunctionName = config.Name("api"),
                Runtime = Runtime.NODEJS_24_X,
                Architecture = Architecture.ARM_64,
                Handler = "index.handler",
                Code = Code.FromAsset(config.ApiCodePath),
                MemorySize = 512,
                Timeout = Duration.Seconds(29),
                LogGroup = apiLogs,
                Environment = new System.Collections.Generic.Dictionary<string, string>
                {
                    { "TABLE_NAME", DataTable.TableName },
                    { "IMAGE_BUCKET", ImageBucket.BucketName },
                    { "IMAGE_BASE_URL", $"{origin}/img" },
                    { "USER_POOL_ID", UserPool.UserPoolId },
                    { "USER_POOL_CLIENT_ID", UserPoolClient.UserPoolClientId },
                    { "ALLOWED_ORIGIN", origin },
                },
            });
            DataTable.GrantReadWriteData(ApiFunction);

            // Dedicated import Lambda: fetches arbitrary URLs, so it gets its own reserved-concurrency cap
            // (a flood cannot exhaust the account) and only the table (no image bucket, no user pool).
            var importLogs = new LogGroup(this, "ImportLogs", new LogGroupProps
            {
                LogGroupName = $"/aws/lambda/{config.Name("import")}",
                Retention = RetentionDays.ONE_MONTH,
                RemovalPolicy = RemovalPolicy.DESTROY,
            });
            ImportFunction = new Amazon.CDK.AWS.Lambda.Function(this, "ImportFunction", new Amazon.CDK.AWS.Lambda.FunctionProps
            {
                FunctionName = config.Name("import"),
                Runtime = Runtime.NODEJS_24_X,
                Architecture = Architecture.ARM_64,
                Handler = "index.handler",
                Code = Code.FromAsset(config.ImportCodePath),
                MemorySize = 512,
                Timeout = Duration.Seconds(29),
                ReservedConcurrentExecutions = config.ImportReservedConcurrency,
                LogGroup = importLogs,
                Environment = new System.Collections.Generic.Dictionary<string, string>
                {
                    { "TABLE_NAME", DataTable.TableName },
                },
            });
            DataTable.GrantReadWriteData(ImportFunction);
            ImageBucket.GrantReadWrite(ApiFunction);

            var authorizer = new HttpUserPoolAuthorizer("JwtAuthorizer", UserPool, new HttpUserPoolAuthorizerProps
            {
                UserPoolClients = new[] { UserPoolClient },
                IdentitySource = new[] { "$request.header.Authorization" },
            });

            var apiCert = new Certificate(this, "ApiCert", new CertificateProps
            {
                DomainName = config.ApiDomain,
                Validation = CertificateValidation.FromDns(zone),
            });
            var apiDomain = new Apigw.DomainName(this, "ApiDomain", new Apigw.DomainNameProps
            {
                DomainName = config.ApiDomain,
                Certificate = apiCert,
            });

            Api = new Apigw.HttpApi(this, "HttpApi", new Apigw.HttpApiProps
            {
                ApiName = config.Name("api"),
                DefaultAuthorizer = authorizer,
                DefaultIntegration = new HttpLambdaIntegration("ApiIntegration", ApiFunction),
                DefaultDomainMapping = new Apigw.DomainMappingOptions { DomainName = apiDomain },
                CorsPreflight = new Apigw.CorsPreflightOptions
                {
                    AllowOrigins = new[] { origin },
                    AllowCredentials = true,
                    AllowHeaders = new[] { "Authorization", "Content-Type" },
                    AllowMethods = new[]
                    {
                        Apigw.CorsHttpMethod.GET, Apigw.CorsHttpMethod.POST, Apigw.CorsHttpMethod.PUT,
                        Apigw.CorsHttpMethod.PATCH, Apigw.CorsHttpMethod.DELETE, Apigw.CorsHttpMethod.OPTIONS,
                    },
                    MaxAge = Duration.Hours(1),
                },
            });
            // Explicit proxy route so every method carries the authorizer; $default (from DefaultIntegration) is authorized too.
            Api.AddRoutes(new Apigw.AddRoutesOptions
            {
                Path = "/{proxy+}",
                Methods = new[] { Apigw.HttpMethod.GET, Apigw.HttpMethod.POST, Apigw.HttpMethod.PUT, Apigw.HttpMethod.PATCH, Apigw.HttpMethod.DELETE },
                Integration = new HttpLambdaIntegration("ProxyIntegration", ApiFunction),
                Authorizer = authorizer,
            });

            // The more specific route wins over /{proxy+}, sending imports to their own capped Lambda.
            Api.AddRoutes(new Apigw.AddRoutesOptions
            {
                Path = "/recipes/import",
                Methods = new[] { Apigw.HttpMethod.POST },
                Integration = new HttpLambdaIntegration("ImportIntegration", ImportFunction),
                Authorizer = authorizer,
            });

            // ---- Hosting (SPA + images through CloudFront) ----
            var stripImgPrefix = new Amazon.CDK.AWS.CloudFront.Function(this, "StripImgPrefix", new Amazon.CDK.AWS.CloudFront.FunctionProps
            {
                FunctionName = config.Name("strip-img"),
                Runtime = FunctionRuntime.JS_2_0,
                Code = FunctionCode.FromInline(
                    "function handler(event) { var r = event.request; r.uri = r.uri.replace(/^\\/img/, ''); return r; }"),
            });

            Distribution = new Distribution(this, "Distribution", new DistributionProps
            {
                Comment = config.Name("web"),
                DomainNames = new[] { config.Domain },
                Certificate = globalCert,
                DefaultRootObject = "index.html",
                MinimumProtocolVersion = SecurityPolicyProtocol.TLS_V1_2_2021,
                DefaultBehavior = new BehaviorOptions
                {
                    Origin = S3BucketOrigin.WithOriginAccessControl(SpaBucket),
                    ViewerProtocolPolicy = ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    CachePolicy = CachePolicy.CACHING_OPTIMIZED,
                },
                AdditionalBehaviors = new System.Collections.Generic.Dictionary<string, IBehaviorOptions>
                {
                    {
                        "img/*", new BehaviorOptions
                        {
                            Origin = S3BucketOrigin.WithOriginAccessControl(ImageBucket),
                            ViewerProtocolPolicy = ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                            CachePolicy = CachePolicy.CACHING_OPTIMIZED,
                            AllowedMethods = AllowedMethods.ALLOW_GET_HEAD,
                            FunctionAssociations = new[]
                            {
                                new FunctionAssociation { Function = stripImgPrefix, EventType = FunctionEventType.VIEWER_REQUEST },
                            },
                        }
                    },
                },
                // SPA fallback: unknown paths return index.html so client-side routing works.
                ErrorResponses = new[]
                {
                    new ErrorResponse { HttpStatus = 403, ResponseHttpStatus = 200, ResponsePagePath = "/index.html", Ttl = Duration.Seconds(0) },
                    new ErrorResponse { HttpStatus = 404, ResponseHttpStatus = 200, ResponsePagePath = "/index.html", Ttl = Duration.Seconds(0) },
                },
            });

            // ---- DNS + Cognito Hosted UI custom domain (needs the apex A record to exist first) ----
            var spaRecord = new ARecord(this, "SpaAlias", new ARecordProps
            {
                Zone = zone,
                RecordName = config.Domain + ".",
                Target = RecordTarget.FromAlias(new CloudFrontTarget(Distribution)),
            });
            var authDomain = UserPool.AddDomain("AuthDomain", new UserPoolDomainOptions
            {
                CustomDomain = new CustomDomainOptions { DomainName = config.AuthDomain, Certificate = globalCert },
            });
            authDomain.Node.AddDependency(spaRecord);

            new ARecord(this, "ApiAlias", new ARecordProps
            {
                Zone = zone,
                RecordName = config.ApiDomain + ".",
                Target = RecordTarget.FromAlias(new ApiGatewayv2DomainProperties(apiDomain.RegionalDomainName, apiDomain.RegionalHostedZoneId)),
            });
            new ARecord(this, "AuthAlias", new ARecordProps
            {
                Zone = zone,
                RecordName = config.AuthDomain + ".",
                Target = RecordTarget.FromAlias(new UserPoolDomainTarget(authDomain)),
            });

            // ---- Outputs ----
            Out("TableName", DataTable.TableName);
            Out("UserPoolId", UserPool.UserPoolId);
            Out("UserPoolClientId", UserPoolClient.UserPoolClientId);
            Out("ImageBucketName", ImageBucket.BucketName);
            Out("SpaBucketName", SpaBucket.BucketName);
            Out("DistributionId", Distribution.DistributionId);
            Out("ApiUrl", $"https://{config.ApiDomain}");
            Out("ImportReservedConcurrency", config.ImportReservedConcurrency.ToString());
        }

        private Bucket PrivateBucket(string id, string name, ICorsRule[] cors = null) => new Bucket(this, id, new BucketProps
        {
            BucketName = name,
            BlockPublicAccess = BlockPublicAccess.BLOCK_ALL,
            Encryption = BucketEncryption.S3_MANAGED,
            EnforceSSL = true,
            Cors = cors,
            RemovalPolicy = RemovalPolicy.RETAIN,
        });

        private void Out(string id, string value) => new CfnOutput(this, id, new CfnOutputProps { Value = value });
    }
}
