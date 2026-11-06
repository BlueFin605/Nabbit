using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Amazon.CDK;
using Amazon.CDK.Assertions;
using Infrastructure.Stacks;
using Xunit;

namespace Infrastructure.Tests
{
    public class NabbitStackTests
    {
        private static Template Synth(string llmModelId = null, int? llmGlobalDailyLimit = null)
        {
            var codeDir = Path.Combine(Path.GetTempPath(), "nabbit-test-api");
            Directory.CreateDirectory(codeDir);
            File.WriteAllText(Path.Combine(codeDir, "index.js"), "exports.handler = async () => ({});");

            var importDir = Path.Combine(Path.GetTempPath(), "nabbit-test-import");
            Directory.CreateDirectory(importDir);
            File.WriteAllText(Path.Combine(importDir, "index.js"), "exports.handler = async () => ({});");

            var config = new NabbitConfig { Domain = "nabbit.example.com", ApiCodePath = codeDir, ImportCodePath = importDir, LlmModelId = llmModelId, LlmGlobalDailyLimit = llmGlobalDailyLimit };
            var app = new App();
            var globalCert = Amazon.CDK.AWS.CertificateManager.Certificate.FromCertificateArn(app, "GlobalCert",
                "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000");
            var stack = new NabbitStack(app, "Nabbit", new StackProps { Env = Env(config.Region) }, config, globalCert);
            return Template.FromStack(stack);
        }

        private static Amazon.CDK.Environment Env(string region) =>
            new Amazon.CDK.Environment { Account = "123456789012", Region = region };

        private static IEnumerable<JsonProperty> Resources(Template t, string type) =>
            JsonDocument.Parse(JsonSerializer.Serialize(t.ToJSON())).RootElement.GetProperty("Resources").EnumerateObject()
                .Where(r => r.Value.GetProperty("Type").GetString() == type).ToList();

        [Fact]
        public void Table_HasTtlAndPitr()
        {
            Synth().HasResourceProperties("AWS::DynamoDB::Table", Match.ObjectLike(new Dictionary<string, object>
            {
                { "TableName", "nabbit-data-production" },
                { "BillingMode", "PAY_PER_REQUEST" },
                { "TimeToLiveSpecification", new Dictionary<string, object> { { "AttributeName", "ttl" }, { "Enabled", true } } },
                { "PointInTimeRecoverySpecification", new Dictionary<string, object> { { "PointInTimeRecoveryEnabled", true } } },
            }));
        }

        [Fact]
        public void Buckets_BlockAllPublicAccess()
        {
            var buckets = Resources(Synth(), "AWS::S3::Bucket").ToList();
            Assert.Equal(2, buckets.Count);
            Assert.All(buckets, b =>
            {
                var p = b.Value.GetProperty("Properties").GetProperty("PublicAccessBlockConfiguration");
                foreach (var k in new[] { "BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets" })
                    Assert.True(p.GetProperty(k).GetBoolean(), k);
            });
        }

        [Fact]
        public void ImageBucket_HasSingleOriginPostCors_AndSpaBucketHasNone()
        {
            var buckets = Resources(Synth(), "AWS::S3::Bucket").Select(b => b.Value.GetProperty("Properties")).ToList();
            var withCors = buckets.Where(p => p.TryGetProperty("CorsConfiguration", out _)).ToList();
            var cors = Assert.Single(withCors).GetProperty("CorsConfiguration").GetProperty("CorsRules");
            var rule = Assert.Single(cors.EnumerateArray());
            Assert.Equal(new[] { "https://nabbit.example.com" }, rule.GetProperty("AllowedOrigins").EnumerateArray().Select(e => e.GetString()).ToArray());
            Assert.Equal(new[] { "POST" }, rule.GetProperty("AllowedMethods").EnumerateArray().Select(e => e.GetString()).ToArray());
            Assert.Equal(new[] { "*" }, rule.GetProperty("AllowedHeaders").EnumerateArray().Select(e => e.GetString()).ToArray());
            Assert.Equal(3000, rule.GetProperty("MaxAge").GetInt32());
            Assert.Contains("images", withCors[0].GetProperty("BucketName").GetString());
        }

        [Fact]
        public void BucketPolicies_NeverAllowWildcardPrincipal()
        {
            foreach (var p in Resources(Synth(), "AWS::S3::BucketPolicy"))
                foreach (var st in p.Value.GetProperty("Properties").GetProperty("PolicyDocument").GetProperty("Statement").EnumerateArray())
                {
                    if (st.GetProperty("Effect").GetString() != "Allow") continue;
                    Assert.DoesNotContain("\"*\"", st.GetProperty("Principal").ToString());
                }
        }

        [Fact]
        public void EveryNonOptionsRoute_UsesJwtAuthorizer()
        {
            var t = Synth();
            var routes = Resources(t, "AWS::ApiGatewayV2::Route").ToList();
            Assert.NotEmpty(routes);
            Assert.All(routes.Where(r => !RouteKey(r).StartsWith("OPTIONS ")), r =>
            {
                var p = r.Value.GetProperty("Properties");
                Assert.Equal("JWT", p.GetProperty("AuthorizationType").GetString());
                Assert.True(p.TryGetProperty("AuthorizerId", out _));
            });
            t.HasResourceProperties("AWS::ApiGatewayV2::Authorizer", Match.ObjectLike(new Dictionary<string, object> { { "AuthorizerType", "JWT" } }));
        }

        // API Gateway HTTP APIs only answer CORS preflight themselves when no route matches OPTIONS.
        // A $default route (or ANY route) with an authorizer matches OPTIONS and would 401 the browser's unauthenticated preflight.
        [Fact]
        public void NoRoute_CanMatchOptions_SoBuiltInCorsAnswersPreflight()
        {
            var t = Synth();
            var routes = Resources(t, "AWS::ApiGatewayV2::Route").Select(RouteKey).ToList();
            Assert.DoesNotContain("$default", routes);
            Assert.DoesNotContain(routes, k => k.StartsWith("ANY "));
            Assert.All(routes, k => Assert.Contains(k.Split(' ')[0], new[] { "GET", "POST", "PUT", "PATCH", "DELETE" }));
            t.HasResourceProperties("AWS::ApiGatewayV2::Api", Match.ObjectLike(new Dictionary<string, object>
            {
                { "CorsConfiguration", Match.ObjectLike(new Dictionary<string, object>
                    {
                        { "AllowHeaders", Match.ArrayWith(new object[] { "Authorization" }) },
                        { "AllowMethods", Match.ArrayWith(new object[] { "OPTIONS" }) },
                    })
                },
            }));
        }

        private static string RouteKey(JsonProperty r) => r.Value.GetProperty("Properties").GetProperty("RouteKey").GetString();

        private static List<JsonElement> AllowStatementsFor(Template t, string roleLogicalIdPrefix) =>
            Resources(t, "AWS::IAM::Policy")
                .Where(p => p.Value.GetProperty("Properties").GetProperty("Roles").ToString().Contains(roleLogicalIdPrefix))
                .SelectMany(p => p.Value.GetProperty("Properties").GetProperty("PolicyDocument").GetProperty("Statement").EnumerateArray())
                .Where(st => st.GetProperty("Effect").GetString() == "Allow").ToList();

        private static List<string> Actions(JsonElement st) =>
            st.GetProperty("Action").ValueKind == JsonValueKind.Array
                ? st.GetProperty("Action").EnumerateArray().Select(e => e.GetString()).ToList()
                : new List<string> { st.GetProperty("Action").GetString() };

        [Fact]
        public void ImportRole_CanOnlyUpdateItemOnTable()
        {
            var tableActions = AllowStatementsFor(Synth(), "ImportFunctionServiceRole")
                .Where(st => st.GetProperty("Resource").ToString().Contains("DataTable"))
                .SelectMany(Actions).ToList();
            Assert.Equal(new[] { "dynamodb:UpdateItem" }, tableActions.Distinct().ToArray());
        }

        [Fact]
        public void ApiRole_CanOnlyPutObjectsInImageBucket()
        {
            var s3Actions = AllowStatementsFor(Synth(), "ApiFunctionServiceRole")
                .Where(st => Actions(st).Any(a => a.StartsWith("s3:")))
                .SelectMany(Actions).ToList();
            // GrantPut also adds PutObject* variants and Abort*; nothing may read, list or delete.
            Assert.Contains("s3:PutObject", s3Actions);
            Assert.All(s3Actions, a =>
            {
                Assert.StartsWith("s3:", a);
                Assert.DoesNotContain("Get", a);
                Assert.DoesNotContain("List", a);
                Assert.DoesNotContain("Delete", a);
                Assert.NotEqual("s3:*", a);
                Assert.True(a.StartsWith("s3:PutObject") || a.StartsWith("s3:Abort"), a);
            });
        }

[Fact]
        public void ImportRole_CanOnlyPutObjectsInImageBucket_AndHasImageBucketEnv()
        {
            var t = Synth();
            var s3Actions = AllowStatementsFor(t, "ImportFunctionServiceRole")
                .Where(st => Actions(st).Any(a => a.StartsWith("s3:")))
                .SelectMany(Actions).ToList();
            Assert.Contains("s3:PutObject", s3Actions);
            Assert.All(s3Actions, a => Assert.True(a.StartsWith("s3:PutObject") || a.StartsWith("s3:Abort"), a));
            // No other new permissions: table is still UpdateItem only, and nothing but dynamodb/s3/logs-style statements exist.
            var allActions = AllowStatementsFor(t, "ImportFunctionServiceRole").SelectMany(Actions).ToList();
            Assert.All(allActions, a => Assert.True(a == "dynamodb:UpdateItem" || a.StartsWith("s3:PutObject") || a.StartsWith("s3:Abort"), a));
            var import = Resources(t, "AWS::Lambda::Function").Single(f =>
                f.Value.GetProperty("Properties").TryGetProperty("FunctionName", out var n) && n.GetString() == "nabbit-import-production");
            Assert.True(import.Value.GetProperty("Properties").GetProperty("Environment").GetProperty("Variables").TryGetProperty("IMAGE_BUCKET", out _));
        }

        private static Dictionary<string, JsonElement> EnvOf(Template t, string functionName)
        {
            var fn = Resources(t, "AWS::Lambda::Function").Single(f =>
                f.Value.GetProperty("Properties").TryGetProperty("FunctionName", out var n) && n.GetString() == functionName);
            return fn.Value.GetProperty("Properties").GetProperty("Environment").GetProperty("Variables")
                .EnumerateObject().ToDictionary(p => p.Name, p => p.Value);
        }

        private static List<JsonElement> BedrockStatements(Template t, string rolePrefix) =>
            AllowStatementsFor(t, rolePrefix).Where(st => Actions(st).Any(a => a.StartsWith("bedrock:"))).ToList();

        private static List<string> ResourceStrings(JsonElement st) =>
            st.GetProperty("Resource").ValueKind == JsonValueKind.Array
                ? st.GetProperty("Resource").EnumerateArray().Select(e => e.ToString()).ToList()
                : new List<string> { st.GetProperty("Resource").ToString() };

        [Fact]
        public void LlmModelId_Set_PlainModel_GrantsInvokeModelOnFoundationModelOnly()
        {
            var t = Synth("anthropic.claude-3-5-haiku-20241022-v1:0");
            Assert.Equal("anthropic.claude-3-5-haiku-20241022-v1:0", EnvOf(t, "nabbit-import-production")["LLM_MODEL_ID"].GetString());
            var st = Assert.Single(BedrockStatements(t, "ImportFunctionServiceRole"));
            Assert.Equal(new[] { "bedrock:InvokeModel" }, Actions(st).ToArray());
            var res = ResourceStrings(st);
            Assert.Equal(new[] { "arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0" }, res.ToArray());
        }

        [Fact]
        public void LlmModelId_Set_InferenceProfile_GrantsProfileAndFoundationModelArns()
        {
            var t = Synth("us.anthropic.claude-3-5-haiku-20241022-v1:0");
            Assert.Equal("us.anthropic.claude-3-5-haiku-20241022-v1:0", EnvOf(t, "nabbit-import-production")["LLM_MODEL_ID"].GetString());
            var st = Assert.Single(BedrockStatements(t, "ImportFunctionServiceRole"));
            Assert.Equal(new[] { "bedrock:InvokeModel" }, Actions(st).ToArray());
            var res = ResourceStrings(st);
            Assert.Equal(2, res.Count);
            Assert.Contains(res, r => r.Contains(":inference-profile/us.anthropic.claude-3-5-haiku-20241022-v1:0") && r.StartsWith("arn:aws:bedrock:ap-southeast-2:"));
            Assert.Contains(res, r => r == "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0");
            Assert.DoesNotContain(res, r => r == "*");
        }

        [Fact]
        public void LlmModelId_Set_ApiLambdaHasNoBedrockActionOrEnv()
        {
            var t = Synth("us.anthropic.claude-3-5-haiku-20241022-v1:0");
            Assert.Empty(BedrockStatements(t, "ApiFunctionServiceRole"));
            Assert.False(EnvOf(t, "nabbit-api-production").ContainsKey("LLM_MODEL_ID"));
        }

        [Fact]
        public void LlmModelId_Unset_NoBedrockPermissionOrEnvAnywhere()
        {
            var t = Synth();
            Assert.Empty(BedrockStatements(t, "ImportFunctionServiceRole"));
            Assert.Empty(BedrockStatements(t, "ApiFunctionServiceRole"));
            Assert.False(EnvOf(t, "nabbit-import-production").ContainsKey("LLM_MODEL_ID"));
            Assert.False(EnvOf(t, "nabbit-api-production").ContainsKey("LLM_MODEL_ID"));
        }

        [Fact]
        public void LlmGlobalDailyLimit_Set_WithModel_SetsImportEnvOnly()
        {
            var t = Synth("anthropic.claude-haiku-5-5", 50);
            Assert.Equal("50", EnvOf(t, "nabbit-import-production")["LLM_GLOBAL_DAILY_LIMIT"].GetString());
            Assert.False(EnvOf(t, "nabbit-api-production").ContainsKey("LLM_GLOBAL_DAILY_LIMIT"));
        }

        [Fact]
        public void LlmGlobalDailyLimit_Unset_NoEnv_BackendDefaultApplies()
        {
            var t = Synth("anthropic.claude-haiku-5-5");
            Assert.False(EnvOf(t, "nabbit-import-production").ContainsKey("LLM_GLOBAL_DAILY_LIMIT"));
        }

        [Fact]
        public void LlmGlobalDailyLimit_WithoutModel_NoEnv()
        {
            var t = Synth(null, 50);
            Assert.False(EnvOf(t, "nabbit-import-production").ContainsKey("LLM_GLOBAL_DAILY_LIMIT"));
        }

        [Fact]
        public void ImageImportRoute_GoesToImportLambda_WithJwt()
        {
            Synth().HasResourceProperties("AWS::ApiGatewayV2::Route", Match.ObjectLike(new Dictionary<string, object>
            {
                { "RouteKey", "POST /recipes/images/import" },
                { "AuthorizationType", "JWT" },
            }));
        }

        [Fact]
        public void Cors_AllowsOnlyAppOriginWithCredentials()
        {
            Synth().HasResourceProperties("AWS::ApiGatewayV2::Api", Match.ObjectLike(new Dictionary<string, object>
            {
                { "CorsConfiguration", Match.ObjectLike(new Dictionary<string, object>
                    {
                        { "AllowOrigins", new[] { "https://nabbit.example.com" } },
                        { "AllowCredentials", true },
                    })
                },
            }));
        }

        [Fact]
        public void Lambda_IsNode24WithWiredEnvironment()
        {
            Synth().HasResourceProperties("AWS::Lambda::Function", Match.ObjectLike(new Dictionary<string, object>
            {
                { "Runtime", "nodejs24.x" },
                { "Environment", Match.ObjectLike(new Dictionary<string, object>
                    {
                        { "Variables", Match.ObjectLike(new Dictionary<string, object>
                            {
                                { "TABLE_NAME", Match.AnyValue() },
                                { "IMAGE_BUCKET", Match.AnyValue() },
                                { "USER_POOL_ID", Match.AnyValue() },
                            })
                        },
                    })
                },
            }));
        }

        [Fact]
        public void ImportLambda_HasReservedConcurrency_AndOwnAuthorizedRoute()
        {
            var t = Synth();
            t.HasResourceProperties("AWS::Lambda::Function", Match.ObjectLike(new Dictionary<string, object>
            {
                { "FunctionName", "nabbit-import-production" },
                { "ReservedConcurrentExecutions", 5 },
            }));
            t.HasResourceProperties("AWS::ApiGatewayV2::Route", Match.ObjectLike(new Dictionary<string, object>
            {
                { "RouteKey", "POST /recipes/import" },
                { "AuthorizationType", "JWT" },
            }));
            // The general API function must not be capped.
            var api = Resources(t, "AWS::Lambda::Function").Single(f =>
                f.Value.GetProperty("Properties").TryGetProperty("FunctionName", out var n) && n.GetString() == "nabbit-api-production");
            Assert.False(api.Value.GetProperty("Properties").TryGetProperty("ReservedConcurrentExecutions", out _));
        }

        [Fact]
        public void ImportConcurrency_ComesFromConfig()
        {
            var cfg = new NabbitConfig { Domain = "nabbit.example.com", ImportReservedConcurrency = 3 };
            Assert.Equal(3, cfg.ImportReservedConcurrency);
            Assert.Equal(5, new NabbitConfig().ImportReservedConcurrency);
        }

        [Fact]
        public void UserPool_AllowsSelfSignupWithEmailVerification()
        {
            var t = Synth();
            t.HasResourceProperties("AWS::Cognito::UserPool", Match.ObjectLike(new Dictionary<string, object>
            {
                { "UserPoolName", "nabbit-users-production" },
                { "AutoVerifiedAttributes", new[] { "email" } },
                { "UsernameAttributes", new[] { "email" } },
            }));
            t.HasResourceProperties("AWS::Cognito::UserPoolClient", Match.ObjectLike(new Dictionary<string, object>
            {
                { "GenerateSecret", false },
                { "AllowedOAuthFlows", new[] { "code" } },
                { "CallbackURLs", new[] { "https://nabbit.example.com/", "https://nabbit.example.com/auth/callback", "https://nabbit.example.com/callback" } },
                { "LogoutURLs", new[] { "https://nabbit.example.com/" } },
            }));
            t.HasResourceProperties("AWS::Cognito::UserPoolDomain", Match.ObjectLike(new Dictionary<string, object> { { "Domain", "nabbit-auth-production" } }));
        }

        [Fact]
        public void Cognito_HasGoogleIdp_AndClientSupportsIt()
        {
            var t = Synth();
            t.HasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", Match.ObjectLike(new Dictionary<string, object>
            {
                { "ProviderName", "Google" },
                { "ProviderType", "Google" },
            }));
            t.HasResourceProperties("AWS::Cognito::UserPoolClient", Match.ObjectLike(new Dictionary<string, object>
            {
                { "SupportedIdentityProviders", new[] { "COGNITO", "Google" } },
            }));
        }

        [Fact]
        public void Dns_HasAliasRecordsForSpaAndApi()
        {
            var t = Synth();
            t.ResourceCountIs("AWS::Route53::RecordSet", 2);
            t.HasResourceProperties("AWS::CloudFront::Distribution", Match.ObjectLike(new Dictionary<string, object>
            {
                { "DistributionConfig", Match.ObjectLike(new Dictionary<string, object>
                    {
                        { "Aliases", new[] { "nabbit.example.com" } },
                    })
                },
            }));
        }
    }
}
