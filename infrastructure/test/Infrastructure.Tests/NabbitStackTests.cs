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
        private static Template Synth()
        {
            var codeDir = Path.Combine(Path.GetTempPath(), "nabbit-test-api");
            Directory.CreateDirectory(codeDir);
            File.WriteAllText(Path.Combine(codeDir, "index.js"), "exports.handler = async () => ({});");

            var importDir = Path.Combine(Path.GetTempPath(), "nabbit-test-import");
            Directory.CreateDirectory(importDir);
            File.WriteAllText(Path.Combine(importDir, "index.js"), "exports.handler = async () => ({});");

            var config = new NabbitConfig { Domain = "nabbit.example.com", ApiCodePath = codeDir, ImportCodePath = importDir };
            var app = new App();
            var certs = new NabbitCertStack(app, "Certs", new StackProps { Env = Env("us-east-1"), CrossRegionReferences = true }, config);
            var stack = new NabbitStack(app, "Nabbit", new StackProps { Env = Env(config.Region), CrossRegionReferences = true }, config, certs.GlobalCertificate);
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
            t.HasResourceProperties("AWS::Cognito::UserPoolDomain", Match.ObjectLike(new Dictionary<string, object> { { "Domain", "auth.nabbit.example.com" } }));
        }

        [Fact]
        public void Dns_HasAliasRecordsForSpaApiAndAuth()
        {
            var t = Synth();
            t.ResourceCountIs("AWS::Route53::RecordSet", 3);
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
