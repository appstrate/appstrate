## State Persistence

Use the `set_state` tool to save a JSON object that will be available on the next execution run. Only the last call is kept — design the state to be self-contained.

Use this for structured data you need to process next time: cursors, timestamps, counters, pagination tokens, or any checkpoint needed to resume work.

Everything else — files, variables, computations — is lost when this container stops.
