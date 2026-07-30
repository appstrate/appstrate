# Configuring agent resources

Agent manifests can request memory and CPU for each run. These values are hints,
not entitlements: the deployment and execution backend decide the effective
allocation.

## Operator controls

Without an agent hint, Appstrate requests **1536 MiB RAM and 2 vCPU**. The
default operator ceilings are also **1536 MiB and 2 vCPU**, so larger hints are
capped unless the operator raises the ceilings.

Configure the ceilings inside the strict `PLATFORM_RUN_LIMITS` JSON object.
Partial objects are allowed and can be combined with the existing run limits:

```dotenv
PLATFORM_RUN_LIMITS='{"timeout_ceiling_seconds":1800,"max_concurrent_per_org":50,"agent_memory_ceiling_mb":4096,"agent_cpu_ceiling":4}'
```

- `agent_memory_ceiling_mb`: positive integer memory ceiling in MiB; default
  `1536`.
- `agent_cpu_ceiling`: positive integer CPU ceiling in vCPU; default `2`.

Unknown keys or invalid values fail API boot instead of being ignored. An
operator must raise these ceilings to honor hints above 1536 MiB or 2 vCPU.

## Authoring a manifest

Put the optional hint in the Appstrate resource namespace:

```json
{
  "name": "@acme/report-agent",
  "version": "1.0.0",
  "type": "agent",
  "schema_version": "0.1",
  "display_name": "Report agent",
  "author": "Acme",
  "_meta": {
    "dev.appstrate/resources": {
      "memory_mb": 4096,
      "cpu": 4
    }
  }
}
```

Both fields are optional, but the resource object must contain at least one:

- `memory_mb`: positive safe integer MiB.
- `cpu`: positive safe integer vCPU. Fractional CPU values are not supported.

The object is strict; unknown fields are rejected. If a dimension is absent,
Appstrate uses its default (1536 MiB or 2 vCPU). The hint remains a request,
never a reservation, host-capacity guarantee, or entitlement.

## Effective allocation

Appstrate resolves each run once:

```text
effective memory = min(requested memory or 1536, operator memory ceiling)
effective CPU    = min(requested CPU or 2, operator CPU ceiling,
                       backend CPU maximum when applicable)
```

If an explicitly declared dimension is capped, package import returns a
non-blocking warning naming that dimension and the effective value. Defaults
that are reduced without an explicit declaration do not produce author
warnings. The runtime prompt announces only the effective allocation, never the
hint or ceiling.

## Backend behavior

- **Docker:** memory and CPU are hard container limits; CPU is a quota, not a
  promise that fewer cores will be visible. When the workspace is a RAM-backed
  tmpfs, its usage counts toward the container RAM limit.
- **Firecracker:** the values are an agent sizing budget, not a hard
  agent-only cgroup. The microVM adds or shares capacity for system and sidecar
  overhead, so total visible capacity may be higher. The portable Firecracker
  agent CPU maximum is 7 vCPU because the VM is capped at 8 and a sidecar may
  require one. The writable root, including `/workspace`, is a tmpfs capped at
  50% of guest RAM; all writes consume the same guest RAM shared with the
  agent, system, and sidecar.
- **Process:** the backend ignores `WorkloadSpec.resources`; resource hints do
  not change host-process limits, and the prompt and import warning remain
  silent.
- **Unknown or undeclared backend:** resource semantics fail closed, so the
  prompt and warning remain silent. Selecting an unregistered `RUN_ADAPTER`
  still fails when the platform resolves the backend.

## Out of scope

Resource hints do not currently change compute pricing, provide aggregate
admission control or scheduler capacity guarantees, or guarantee host
availability. Operators remain responsible for provisioning enough real
capacity for their configured ceilings.
