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
        public void EveryRoute_UsesJwtAuthorizer()
        {
            var t = Synth();
            var routes = Resources(t, "AWS::ApiGatewayV2::Route").ToList();
            Assert.NotEmpty(routes);
            Assert.All(routes, r =>
            {
                var p = r.Value.GetProperty("Properties");
                Assert.Equal("JWT", p.GetProperty("AuthorizationType").GetString());
                Assert.True(p.TryGetProperty("AuthorizerId", out _));
            });
            t.HasResourceProperties("AWS::ApiGatewayV2::Authorizer", Match.ObjectLike(new Dictionary<string, object> { { "AuthorizerType", "JWT" } }));
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
