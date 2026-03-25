export const SIDECAR_MEMORY_BYTES = 256 * 1024 * 1024;
export const SIDECAR_NANO_CPUS = 500_000_000;
export const SIDECAR_EXPOSED_PORTS = { "8080/tcp": {} } as const;
export const SIDECAR_PORT_BINDINGS = { "8080/tcp": [{ HostPort: "0" }] };
export const SIDECAR_INTERNAL_PORT = "8080/tcp" as const;
