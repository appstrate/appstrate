# MCPB manifest schemas (test fixtures)

`mcpb-manifest-v0.3.schema.json` and `mcpb-manifest-v0.4.schema.json` are copied verbatim from
the `schemas/` directory of [`@anthropic-ai/mcpb`](https://github.com/anthropics/mcpb) 2.1.2
(MIT licence). `test/mcpb.test.ts` validates the projection's export against them, so an
exported `.mcpb` is held to the official schema without a runtime dependency on that package.
