# Provider and routing contracts

## AWS EC2

The adapter uses the official AWS SDK v3 `DescribeInstancesCommand` and `StartInstancesCommand`. Each connection requires a region and an explicit list of existing instance IDs. All inspect/start requests remain inside that configured scope. SDK write retries are disabled; the persisted worker inspects actual state after an unknown outcome. Instance running state is separate from HTTP application readiness. A primary can use a generic connection without AWS credentials.

Example IAM policy (replace every placeholder, use a dedicated identity, and constrain the Describe action further where AWS supports it):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ec2:DescribeInstances"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ec2:StartInstances"], "Resource": "arn:aws:ec2:REGION:ACCOUNT:instance/INSTANCE_ID" }
  ]
}
```

No StopInstances, purchase, reinstallation, arbitrary shell execution or database promotion exists. Starting an EC2 without an Elastic IP can change its public address. Use explicitly prepared stable origin IPs and verify them; the controller never infers DNS targets from an unexpected address change.

Official reference: <https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ec2/>.

## Hostinger VPS

Base URL is fixed to `https://developers.hostinger.com`; bearer authentication is sent only to that host. The adapter uses:

- `GET /api/vps/v1/virtual-machines` (read-only credential validation and scoped resource list)
- `GET /api/vps/v1/virtual-machines/{id}` (inspect)
- `POST /api/vps/v1/virtual-machines/{id}/start` (no invented request payload)

Start returns an action receipt. The worker persists its request ID and then polls VM state, followed by independent application readiness. Only recognized running/stopped states are normalized; unfamiliar states remain Unknown. The published SDK describes `state` as a string, so real account payloads must be verified during deployment. Unknown states never manufacture readiness. Tokens inherit the creator's permissions; restrict account/resource scope as far as Hostinger supports. Documentation currently describes a 90 request/minute shared user limit. Bounded retry backoff honors Retry-After for orchestration.

Official API: <https://docs.hostinger.com/api-reference/overview>. Endpoint/models reference: <https://github.com/hostinger/api-python-sdk>.

## Cloudflare DNS

Use a scoped API token with **Zone DNS Read + Edit** on the exact selected zone. Token validation reads `/user/tokens/verify`; routing validation checks actual accessible records. Select **all** existing A/AAAA record IDs for the exact hostname. The adapter rejects CNAME conflicts, omitted address-family routes, extra A/AAAA records and inconsistent proxy modes. It never deletes records or changes nameservers.

Read/plan operations are distinct from apply. Apply sends PATCH containing only `content` so TTL, proxy mode and unrelated flags are preserved. Snapshot comparisons include content, record IDs, proxy mode, TTL and the observed modification timestamp. Unexpected changes require reconciliation. Every configured address family needs a corresponding explicit target IP on both origins; stale IPv6 routes cannot bypass the switch silently.

Already-proxied records are the main mode and use Cloudflare-managed TTL. DNS-only mode requires explicit acknowledgment of effective TTL and resolver/client caching. A 30-second TTL is not promised for proxied records. Whole-set readback and one public identity probe provide measured local evidence; they do not prove global propagation.

Official references: <https://developers.cloudflare.com/api/resources/dns/subresources/records/> and <https://developers.cloudflare.com/dns/proxy-status/>.

Paid Cloudflare Load Balancing adds provider-managed monitors/pools/steering. It is unavailable in this MVP. Do not enable native failback or another DNS writer on a hostname owned by this controller. See <https://developers.cloudflare.com/load-balancing/>.
