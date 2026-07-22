-- Bench the egress IP as well as the host.
--
-- The failure mode being defended against is Docker Hub's anonymous pull rate limit,
-- which is counted per source IP — not per host. Vast hosts are distinct accounts but
-- can share one datacenter NAT: offers 40875484 (host 549946) and 42230248 (host
-- 434909) both report public_ipaddr 137.175.76.24. Benching only host_id therefore
-- leaves the sibling host behind the same exhausted quota fully selectable, and the
-- stream simply stalls again on the neighbour.

ALTER TABLE streams ADD COLUMN vast_host_ip TEXT;
ALTER TABLE host_failures ADD COLUMN host_ip TEXT;

CREATE INDEX IF NOT EXISTS idx_host_failures_host_ip ON host_failures(host_ip);
