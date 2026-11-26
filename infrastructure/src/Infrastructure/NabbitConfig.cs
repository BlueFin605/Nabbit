using System;
using System.IO;
using System.Text.Json;

namespace Infrastructure
{
    /// <summary>Non-secret deployment config, read from the "nabbit" section of config.json.</summary>
    public sealed class NabbitConfig
    {
        public string Prefix { get; set; } = "nabbit";
        public string Region { get; set; } = "ap-southeast-2";
        public string Environment { get; set; } = "production";
        public string Domain { get; set; }

        /// <summary>Optional. When set the zone is imported by id instead of looked up (lets synth run without AWS credentials).</summary>
        public string HostedZoneId { get; set; }

        /// <summary>Reserved concurrency cap for the dedicated import Lambda. 0 = no reservation (needed while the account Lambda quota is 50, since AWS requires 50 unreserved).</summary>
        public int ImportReservedConcurrency { get; set; } = 5;

        /// <summary>Optional Bedrock model id or cross-region inference-profile id (e.g. "us.anthropic...") for the import Lambda's LLM fallback parser. Unset = feature off: no LLM_MODEL_ID env var, no Bedrock permission.</summary>
        public string LlmModelId { get; set; }

        /// <summary>Optional app-wide cap on LLM calls per UTC day, across all users. Null = the backend default (300); 0 = no LLM calls. Only applied when LlmModelId is set.</summary>
        public int? LlmGlobalDailyLimit { get; set; }

        /// <summary>Optional NAME of an SSM SecureString parameter holding a YouTube Data API v3 key (the name, never the key). Set = the import Lambda gets YOUTUBE_API_KEY_PARAM and ssm:GetParameter on that parameter only. Unset = feature off.</summary>
        public string YoutubeApiKeyParam { get; set; }

        /// <summary>Folder holding the built API router (index.js). Relative to the cdk working directory.</summary>
        public string ApiCodePath { get; set; } = "../backend/dist/api";

        /// <summary>Folder holding the built import Lambda (index.js). Relative to the cdk working directory.</summary>
        public string ImportCodePath { get; set; } = "../backend/dist/import";

        /// <summary>Set from CDK context (never config.json): use a shared, externally managed Cognito pool and hosted-UI domain instead of creating them.</summary>
        public (string PoolId, string Domain)? ExternalIdentity { get; set; }

        /// <summary>Builds <see cref="ExternalIdentity"/> from the two context values: both set or both empty, else throws.</summary>
        public static (string PoolId, string Domain)? ResolveExternalIdentity(string poolId, string domain)
        {
            var hasPool = !string.IsNullOrWhiteSpace(poolId);
            var hasDomain = !string.IsNullOrWhiteSpace(domain);
            if (hasPool != hasDomain)
                throw new InvalidOperationException("context \"identityUserPoolId\" and \"identityDomain\" must be provided together (or both omitted)");
            return hasPool ? (poolId.Trim(), domain.Trim()) : null;
        }

        public string ApiDomain => $"api.{Domain}";
        /// <summary>Cognito allows only 4 custom domains per (non-adjustable) account quota, so the hosted UI uses a Cognito prefix domain.</summary>
        public string AuthDomainPrefix => Name("auth");
        public string AuthDomain => $"{AuthDomainPrefix}.auth.{Region}.amazoncognito.com";
        public string Name(string name) => $"{Prefix}-{name}-{Environment}";

        /// <summary>Hosted zone is the parent of the app domain (nabbit.example.com -> example.com).</summary>
        public string ZoneName
        {
            get
            {
                var i = Domain.IndexOf('.');
                return i < 0 ? Domain : Domain[(i + 1)..];
            }
        }

        public Amazon.CDK.AWS.Route53.IHostedZone ResolveZone(Constructs.Construct scope, string id) =>
            string.IsNullOrWhiteSpace(HostedZoneId)
                ? Amazon.CDK.AWS.Route53.HostedZone.FromLookup(scope, id, new Amazon.CDK.AWS.Route53.HostedZoneProviderProps { DomainName = ZoneName })
                : Amazon.CDK.AWS.Route53.HostedZone.FromHostedZoneAttributes(scope, id, new Amazon.CDK.AWS.Route53.HostedZoneAttributes { HostedZoneId = HostedZoneId, ZoneName = ZoneName });

        public static NabbitConfig Load(string path)
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (!doc.RootElement.TryGetProperty("nabbit", out var s))
                throw new InvalidOperationException($"'{path}' has no \"nabbit\" section");

            string Str(string p, string d) =>
                s.TryGetProperty(p, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString() : d;

            var cfg = new NabbitConfig
            {
                Prefix = Str("prefix", "nabbit"),
                Region = Str("region", "ap-southeast-2"),
                Environment = Str("environment", "production"),
                Domain = Str("domain", null),
                HostedZoneId = Str("hostedZoneId", null),
                ApiCodePath = Str("apiCodePath", "../backend/dist/api"),
                ImportCodePath = Str("importCodePath", "../backend/dist/import"),
                LlmModelId = Str("llmModelId", null),
                YoutubeApiKeyParam = Str("youtubeApiKeyParam", null),
            };
            if (s.TryGetProperty("importReservedConcurrency", out var c) && c.ValueKind == JsonValueKind.Number)
                cfg.ImportReservedConcurrency = c.GetInt32();
            if (s.TryGetProperty("llmGlobalDailyLimit", out var g) && g.ValueKind == JsonValueKind.Number)
                cfg.LlmGlobalDailyLimit = g.GetInt32() < 0
                    ? throw new InvalidOperationException("config \"nabbit.llmGlobalDailyLimit\" must be 0 or more")
                    : g.GetInt32();
            if (string.IsNullOrWhiteSpace(cfg.Domain))
                throw new InvalidOperationException("config \"nabbit.domain\" is required");
            return cfg;
        }
    }
}
