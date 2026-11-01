using Amazon.CDK;
using Amazon.CDK.AWS.CertificateManager;
using Amazon.CDK.AWS.Route53;
using Constructs;

namespace Infrastructure.Stacks
{
    /// <summary>
    /// us-east-1 companion to NabbitStack: CloudFront and Cognito custom domains only accept
    /// certificates from us-east-1. One cert covers the SPA domain and the auth domain.
    /// </summary>
    public class NabbitCertStack : Stack
    {
        public ICertificate GlobalCertificate { get; }

        public NabbitCertStack(Construct scope, string id, IStackProps props, NabbitConfig config) : base(scope, id, props)
        {
            var zone = config.ResolveZone(this, "Zone");
            GlobalCertificate = new Certificate(this, "GlobalCert", new CertificateProps
            {
                DomainName = config.Domain,
                SubjectAlternativeNames = new[] { config.AuthDomain },
                Validation = CertificateValidation.FromDns(zone),
            });
        }
    }
}
