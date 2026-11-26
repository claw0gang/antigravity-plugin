# Protocol test fixtures

These synthetic NDJSON streams exercise explicit model acknowledgement, exact conversation binding, stable step indexes, repeated active states, terminal tool and text results, and additive metadata. They contain no native account, host or session information.

The parser validates the reported fields and rejects unknown semantic events and inconsistent results. Fixture execution establishes source behavior only, not native inference or installed Gateway behavior.

See the [headless CLI documentation](https://antigravity.google/docs/cli/headless/).
