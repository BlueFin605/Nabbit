using Amazon.CDK;
using Infrastructure.Stacks;

namespace Infrastructure
{
    sealed class Program
    {
        public static void Main(string[] args)
        {
            var app = new App();
            var configFile = app.Node.TryGetContext("configFile")?.ToString() ?? "../config.json";
            var config = NabbitConfig.Load(configFile);

            var account = System.Environment.GetEnvironmentVariable("CDK_DEFAULT_ACCOUNT");
            var tags = new System.Collections.Generic.Dictionary<string, string>
            {
                { "Project", config.Prefix },
                { "Environment", config.Environment },
            };

            // CloudFront and the Cognito custom domain need certificates in us-east-1.
            var certs = new NabbitCertStack(app, $"Nabbit-Certs-{config.Environment}", new StackProps
            {
                Env = new Amazon.CDK.Environment { Account = account, Region = "us-east-1" },
                CrossRegionReferences = true,
                Tags = tags,
            }, config);

            new NabbitStack(app, $"Nabbit-{config.Environment}", new StackProps
            {
                Env = new Amazon.CDK.Environment { Account = account, Region = config.Region },
                CrossRegionReferences = true,
                Tags = tags,
            }, config, certs.GlobalCertificate);

            app.Synth();
        }
    }
}
