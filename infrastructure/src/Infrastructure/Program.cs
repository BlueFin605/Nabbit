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

            // CloudFront and the Cognito custom domain need a us-east-1 certificate. deploy-infra.ps1
            // finds or requests it in ACM and passes the ARN in (no us-east-1 CDK stack needed).
            var certArn = app.Node.TryGetContext("globalCertArn")?.ToString();
            if (string.IsNullOrWhiteSpace(certArn))
                throw new System.InvalidOperationException("context \"globalCertArn\" is required (pass it with -c globalCertArn=...; see infrastructure/SYSDOC.md)");
            var globalCert = Amazon.CDK.AWS.CertificateManager.Certificate.FromCertificateArn(app, "GlobalCert", certArn);

            new NabbitStack(app, $"Nabbit-{config.Environment}", new StackProps
            {
                Env = new Amazon.CDK.Environment { Account = account, Region = config.Region },
                Tags = tags,
            }, config, globalCert);

            app.Synth();
        }
    }
}
